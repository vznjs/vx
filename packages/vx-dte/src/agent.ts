// `vx dte agent`: one CI job's share of a run. It joins the run's relay
// with what its machine has, runs what the orchestrator sends in its own
// checkout, as many at once as its cores and memory hold by each task's
// recorded peak. A task's dependencies' files come from the workspace's
// cache by the keys its order names, and its own files and output go
// there under its key; the relay carries only orders and status.

import { realpathSync } from 'node:fs'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  localFloor,
  machineMemoryBytes,
  ui,
  machineParallelism,
  type ExecuteRequest,
  type LocalFloor,
  type TaskArtifacts,
} from '@vzn/vx'
import type { AgentInfo, RunOrder, ToAgent, WiredResult } from './messages.js'
import { outputFiles } from './outputs.js'
import { sealAgent, type Proof } from './seal.js'
import { join, RelayError } from './wire.js'

/** Names whose value is this machine's, never the orchestrator's. */
const HOST_ENV = [
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'npm_execpath',
  'PNPM_HOME',
  'COREPACK_HOME',
]

export async function runAgent(opts: {
  relay: string
  run: string
  /** `AgentSpawn.id`, when the run started it. */
  id?: string
  root: string
  token: string | undefined
  /** What admits it to the orchestrator's session: the run's key, or its CI identity. */
  proof: Proof
  artifacts: TaskArtifacts
}): Promise<number> {
  const tree = Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: opts.root })
    .stdout.toString()
    .trim()
  const cores = machineParallelism()
  const memory = machineMemoryBytes()
  const info: AgentInfo = {
    v: 1,
    ...(opts.id === undefined ? {} : { id: opts.id }),
    cores,
    memory,
    tree,
  }
  const me = await sealAgent(
    (signed) => join(opts.relay, opts.run, 'agent', signed, opts.token),
    opts.run,
    opts.proof,
    { ...info },
  )
  const running = new Map<string, AbortController>()
  const queue: RunOrder[] = []
  const work = new Set<Promise<void>>()
  let root = opts.root
  let realRoot = opts.root
  const myReal = realpathSync(opts.root)
  let floor: LocalFloor | undefined
  let usedCores = 0
  let usedMemory = 0

  /** Saves the task's files and output under `key` and says so. */
  const reply = async (
    m: RunOrder,
    key: string,
    res: WiredResult & { stdout: string; stderr: string },
  ): Promise<void> => {
    const { stdout, stderr, ...result } = res
    await opts.artifacts.save(
      key,
      {
        id: m.task,
        projectDir: path.join(opts.root, m.project),
        command: m.command,
        outputs: m.outputs,
        nestedProjectDirs: m.nested.map((n) => path.join(opts.root, n)),
      },
      {
        stdout,
        stderr,
        durationMs: res.durationMs,
        ...(res.cpuMs === undefined ? {} : { cpuMs: res.cpuMs }),
        ...(res.peakRssBytes === undefined ? {} : { peakRssBytes: res.peakRssBytes }),
        env: m.env,
      },
    )
    await me.send('orchestrator', { type: 'end', task: m.task, key, result })
  }

  /** Starts each queued task that fits what is free; with nothing running, the first one. */
  const start = (): void => {
    for (let i = 0; i < queue.length;) {
      const m = queue[i]!
      const fits =
        running.size === 0 || (usedCores + m.cores <= cores && usedMemory + m.memory <= memory)
      if (!fits) {
        i++
        continue
      }
      queue.splice(i, 1)
      usedCores += m.cores
      usedMemory += m.memory
      const p = runTask(m)
        .catch(async (err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          ui.print('err', ui.status('error', m.task, `could not run: ${reason}`))
          await me
            .send('orchestrator', { type: 'fault', task: m.task, reason })
            .catch(() => undefined)
        })
        .finally(() => {
          usedCores -= m.cores
          usedMemory -= m.memory
          work.delete(p)
          start()
        })
      work.add(p)
    }
  }

  const runTask = async (m: RunOrder): Promise<void> => {
    const stop = new AbortController()
    running.set(m.task, stop)
    // Not awaited: the task does not wait on the relay to say it began.
    void me.send('orchestrator', { type: 'start', task: m.task }).catch(() => undefined)
    try {
      for (const d of m.deps) {
        const got = await opts.artifacts.restore(d.key, {
          id: d.task,
          projectDir: path.join(opts.root, d.project),
          command: '',
          outputs: d.outputs,
        })
        if (got === null)
          throw new Error(`${d.task}'s entry ${d.key} is in no cache this agent reads`)
      }
      // An earlier task's files under these outputs would ship as this one's.
      for (const f of await outputFiles(opts.root, m.project, m.outputs)) {
        await rm(path.join(opts.root, f), { force: true })
      }
      // Here as the orchestrator's: its paths, real ones first, made ours.
      const mine = <T>(v: T): T =>
        swapRoots(v, [
          [realRoot, myReal],
          [root, opts.root],
        ])
      const made = await bind(opts.root, m.binds ?? [])
      const req: ExecuteRequest = {
        taskId: m.task,
        workspaceRoot: opts.root,
        command: m.command,
        forwardArgs: [],
        cwd: path.join(opts.root, m.cwd),
        env: localEnv(m.env, root, opts.root),
        envDefine: {},
        capture: { stdout: true, stderr: true },
        onStdout: () => {},
        onStderr: () => {},
        signal: stop.signal,
        outputs: m.outputs,
        ...(m.timeoutMs === undefined ? {} : { timeoutMs: m.timeoutMs }),
        ...(m.sandbox === undefined ? {} : { sandbox: mine(m.sandbox) }),
      }
      floor ??= localFloor()
      ui.print('out', ui.status('info', m.task, ui.dim('running')))
      const { outputs: _, ...res } = await floor.execute(req)
      const took = ui.dim(`${Math.round(res.durationMs)}ms`)
      ui.print(
        'out',
        res.exitCode === 0
          ? ui.status('ok', m.task, took)
          : ui.status('error', m.task, [`exit ${res.exitCode} `, took]),
      )
      // A bind the task never wrote is not its output.
      for (const f of made) if ((await lstat(f)).size === 0) await rm(f, { force: true })
      // Its violations name the orchestrator's paths. As JSON first: the swap
      // round-trips them through JSON, which leaves a Date a string.
      const back = swapRoots(
        res.violations.map((v) => ({ ...v, timestamp: v.timestamp.toISOString() })),
        [
          [myReal, realRoot],
          [opts.root, root],
        ],
      )
      // Only a success the sandbox found nothing wrong with is the task's
      // entry; anything else is kept where no lookup finds it.
      const key =
        res.exitCode === 0 && res.violations.length === 0 && m.key !== undefined ? m.key : m.runKey
      await reply(m, key, {
        ...res,
        violations: back,
      })
    } finally {
      running.delete(m.task)
    }
  }

  // What it holds, each heartbeat: the orchestrator's lease on each task.
  const held = setInterval(() => {
    if (running.size === 0 && queue.length === 0) return
    void me
      .send('orchestrator', {
        type: 'held',
        running: [...running.keys()],
        queued: queue.map((q) => q.task),
      })
      .catch(() => undefined)
  }, me.heartbeatMs)
  try {
    for (;;) {
      let messages
      try {
        messages = await me.poll()
      } catch (err) {
        if (err instanceof RelayError && err.status === 410) return 0
        throw err
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          if ((body as { type?: string }).type === 'closed') return 0
          continue
        }
        const m = body as ToAgent
        if (m.type === 'refused') {
          ui.print('err', ui.status('error', 'vx dte agent', `refused: ${m.reason}`))
          return 1
        }
        if (m.type === 'exit') return 0
        if (m.type === 'welcome') {
          ui.print(
            'out',
            ui.report('vx dte agent', [
              ['agent', ui.id(m.name)],
              ['run', opts.run],
              ['relay', opts.relay],
              ['machine', `${cores} cores · ${gb(memory)}`],
            ]),
          )
        } else if (m.type === 'cancel') {
          const at = queue.findIndex((q) => q.task === m.task)
          if (at < 0) running.get(m.task)?.abort()
          else {
            const order = queue.splice(at, 1)[0]!
            await reply(order, order.runKey, {
              exitCode: 130,
              signal: 'SIGTERM',
              durationMs: 0,
              stdout: '',
              stderr: '',
              violations: [],
            })
          }
        } else if (m.type === 'batch') {
          // Every batch of a run names the same orchestrator root.
          root = m.root
          realRoot = m.realRoot
          if (m.sandboxes !== undefined) {
            await floor?.close()
            floor = localFloor(m.sandboxes)
          }
          queue.push(...m.tasks)
          start()
        }
      }
    }
  } finally {
    clearInterval(held)
    queue.length = 0
    for (const c of running.values()) c.abort()
    await Promise.all(work)
    await floor?.close()
    await me.leave()
  }
}

/**
 * The orchestrator's env for a task, made this machine's: its checkout root
 * swapped for ours, host names from our own env, and PATH our own behind
 * the workspace's bin directories.
 */
export function localEnv(
  env: Readonly<Record<string, string>>,
  remoteRoot: string,
  root: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) out[k] = v.replaceAll(remoteRoot, root)
  for (const k of HOST_ENV) out[k] = process.env[k]
  const bins = (out['PATH'] ?? '').split(':').filter((p) => p.startsWith(root))
  out['PATH'] = [...bins, process.env['PATH'] ?? ''].join(':')
  return out
}

/**
 * `value` with each path under a `from` root moved under its `to`, in one
 * pass: a root that holds another (`/ws`, `/ws2`) is not swapped twice.
 */
export function swapRoots<T>(value: T, pairs: readonly (readonly [string, string])[]): T {
  // The first pair naming a root wins.
  const to = new Map([...pairs].reverse().map(([f, t]) => [esc(f), esc(t)]))
  const alt = [...to.keys()]
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const text = JSON.stringify(value).replace(
    new RegExp(`(?<=^|[^\\w.-])(${alt})(?=[/"]|\\\\|$)`, 'g'),
    (m) => to.get(m)!,
  )
  return JSON.parse(text) as T
}

/** A path as JSON spells it inside a string. */
const esc = (p: string): string => JSON.stringify(p).slice(1, -1)

/** Makes each bind that is missing here: the empty files it made, to take back. */
async function bind(
  root: string,
  binds: readonly { path: string; dir: boolean }[],
): Promise<string[]> {
  const made: string[] = []
  for (const b of binds) {
    const abs = path.join(root, b.path)
    if (await lstat(abs).catch(() => undefined)) continue
    if (b.dir) {
      await mkdir(abs, { recursive: true })
      continue
    }
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, '', { flag: 'wx' })
    made.push(abs)
  }
  return made
}

const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
