// `vx dte agent`: one CI job's share of a run. It joins the run's relay
// with what its machine has, runs what the orchestrator sends in its own
// checkout, as many at once as its cores and memory hold by each task's
// recorded peak, and sends back each task's streams and the files its
// outputs left.

import { realpathSync } from 'node:fs'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  localFloor,
  machineMemoryBytes,
  machineParallelism,
  type ExecuteRequest,
  type ExecuteResult,
  type LocalFloor,
} from '@vzn/vx'
import { fromParts, outputFiles, pack, toParts, unpack } from './bundle.js'
import type { AgentInfo, RunOrder, ToAgent } from './messages.js'
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
  size: string
  index?: number
  root: string
  token: string | undefined
  log: (line: string) => void
}): Promise<number> {
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: opts.root })
    .stdout.toString()
    .trim()
  const cores = machineParallelism()
  const memory = machineMemoryBytes()
  const info: AgentInfo = {
    v: 1,
    size: opts.size,
    ...(opts.index === undefined ? {} : { index: opts.index }),
    cores,
    memory,
    commit,
  }
  const me = await join(opts.relay, opts.run, 'agent', info, opts.token)
  opts.log(`vx dte agent ${opts.size} joined run ${opts.run}`)
  const parts = new Map<string, string[]>()
  const running = new Map<string, AbortController>()
  const queue: RunOrder[] = []
  const work = new Set<Promise<void>>()
  let root = opts.root
  let realRoot = opts.root
  const myReal = realpathSync(opts.root)
  let floor: LocalFloor | undefined
  let usedCores = 0
  let usedMemory = 0

  const reply = async (
    task: string,
    res: Omit<ExecuteResult, 'outputs'>,
    files: string[],
  ): Promise<void> => {
    const out = toParts(await pack(opts.root, files, res))
    for (const data of out) await me.send('orchestrator', { type: 'part', task, data })
    await me.send('orchestrator', { type: 'end', task, parts: out.length })
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
        .catch((err: unknown) => opts.log(`vx dte agent: ${m.task}: ${String(err)}`))
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
    try {
      const upstream = parts.get(m.task) ?? []
      parts.delete(m.task)
      if (upstream.length > 0) await unpack(opts.root, fromParts(upstream))
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
      const { outputs: _, ...res } = await floor.execute(req)
      // A bind the task never wrote is not its output.
      for (const f of made) if ((await lstat(f)).size === 0) await rm(f, { force: true })
      // Its violations name the orchestrator's paths.
      const back = swapRoots(res.violations, [
        [myReal, realRoot],
        [opts.root, root],
      ])
      await reply(
        m.task,
        { ...res, violations: back },
        await outputFiles(opts.root, m.project, m.outputs),
      )
    } finally {
      running.delete(m.task)
    }
  }

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
          opts.log(`vx dte agent: refused: ${m.reason}`)
          return 1
        }
        if (m.type === 'part') {
          const list = parts.get(m.task) ?? []
          list.push(m.data)
          parts.set(m.task, list)
        } else if (m.type === 'cancel') {
          const at = queue.findIndex((q) => q.task === m.task)
          if (at < 0) running.get(m.task)?.abort()
          else {
            queue.splice(at, 1)
            const stopped = {
              exitCode: 130,
              signal: 'SIGTERM',
              durationMs: 0,
              stdout: '',
              stderr: '',
              violations: [],
            }
            await reply(m.task, stopped, [])
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
