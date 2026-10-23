// `vx dte worker`: one CI job's share of a run. It joins the run's relay
// with what its machine has, runs what the orchestrator sends in its own
// checkout, each at once: the orchestrator sends what fits the load each
// frame of this worker reports. A task's dependencies' files come from the workspace's
// cache by the keys its order names, and its own files and output go
// there under its key; the relay carries only orders and status.

import { readFileSync, realpathSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  answerRuntime,
  hostPlatform,
  localFloor,
  machineMemoryBytes,
  ui,
  machineParallelism,
  sandboxRequestFor,
  type CacheFacts,
  type ExecuteRequest,
  type LocalFloor,
  type TaskArtifacts,
} from '@vzn/vx'
import {
  HELD_EVERY,
  type Load,
  type WorkerInfo,
  type RunOrder,
  type ToWorker,
  type WiredResult,
} from './messages.js'
import { names, outputFiles } from './outputs.js'
import { sealWorker, type Proof } from './seal.js'
import { join, RelayError } from './wire.js'

/**
 * A save past this is given up: the task faults and runs elsewhere. Main
 * 32f73ed sat 13 min twice: a worker's save never settled, its `held`
 * kept the task's lease, and no `end` came (2026-10-23). Above a remote's
 * own upload deadlines (`turboCache()`: 60 s a request, one resend).
 */
const SAVE_DEADLINE_MS = 5 * 60_000

/** `save`, or a throw once `ms` passes. */
async function saved(save: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      save,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`its outputs did not save within ${ms / 1000} s`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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

export async function runWorker(opts: {
  relay: string
  run: string
  /** `WorkerSpawn.id`, when the run started it. */
  id?: string
  root: string
  token: () => Promise<string | undefined>
  /** What admits it to the orchestrator's session: the run's key, or its CI identity. */
  proof: Proof
  /** The workspace's cache read under the facts it is handed (`CommandContext.artifactsFor`). */
  artifacts: (facts: () => CacheFacts | undefined) => TaskArtifacts
  /** How long a task's save may take before the worker gives the task up; default `SAVE_DEADLINE_MS`. */
  saveDeadlineMs?: number
}): Promise<number> {
  const tree = Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: opts.root })
    .stdout.toString()
    .trim()
  const cores = machineParallelism()
  const memory = machineMemoryBytes()
  const info: WorkerInfo = {
    v: 1,
    ...(opts.id === undefined ? {} : { id: opts.id }),
    cores,
    memory,
    platform: hostPlatform(),
    tree,
  }
  let me
  try {
    me = await sealWorker(
      (signed) => join(opts.relay, opts.run, 'worker', signed, opts.token),
      opts.run,
      opts.proof,
      { ...info },
    )
  } catch (err) {
    // The run ended before this worker came up: nothing is left for it.
    if (err instanceof RelayError && err.status === 410) return 0
    throw err
  }
  // Read as the run reads: its refs, and what its remotes lent.
  let facts: CacheFacts | undefined
  const artifacts = opts.artifacts(() => facts)
  const running = new Map<string, AbortController>()
  const work = new Set<Promise<void>>()
  let root = opts.root
  let realRoot = opts.root
  const myReal = realpathSync(opts.root)
  let floor: LocalFloor | undefined
  const load = loadMeter()
  /**
   * Entries whose files are here, restored or run here, by key: tasks
   * started together wait on one restore, never run before it.
   */
  const present = new Map<string, Promise<void>>()
  /** Of `present`, which files each holds: a task that clears one makes it absent. */
  const holds = new Map<string, (file: string) => boolean>()

  /** Saves the task's files and output under `key` and says so. */
  const reply = async (
    m: RunOrder,
    key: string,
    res: WiredResult & { stdout: string; stderr: string },
  ): Promise<void> => {
    const { stdout, stderr, ...result } = res
    await saved(
      artifacts.save(
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
      ),
      opts.saveDeadlineMs ?? SAVE_DEADLINE_MS,
    )
    if (res.exitCode === 0) {
      present.set(key, Promise.resolve())
      holds.set(key, names(m.project, m.outputs))
    }
    await me.send('orchestrator', { type: 'end', task: m.task, key, result, load: load.now() })
  }

  /** Runs a task the orchestrator sent: it fits what this worker has free. */
  const start = (m: RunOrder): void => {
    let ran = false
    const done = (): void => {
      if (ran) return
      ran = true
      void me
        .send('orchestrator', { type: 'ran', task: m.task, load: load.now() })
        .catch(() => undefined)
    }
    const p = runTask(m, done)
      .catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        ui.print('err', ui.status('error', m.task, `could not run: ${reason}`))
        await me
          .send('orchestrator', { type: 'fault', task: m.task, reason })
          .catch(() => undefined)
      })
      .finally(() => work.delete(p))
    work.add(p)
  }

  // Each probe once per worker, as a run answers it once.
  const probes = new Map<string, Promise<string>>()
  /** The first probe this machine answers otherwise than the orchestrator did. */
  const runtimeDiffers = async (m: RunOrder): Promise<string | undefined> => {
    for (const r of m.runtime ?? []) {
      const dir = r.workspace === true ? '' : m.project
      const k = `${dir}\0${r.command}`
      let p = probes.get(k)
      if (p === undefined) {
        p = answerRuntime(r.command, path.join(opts.root, dir), opts.root, r.workspace === true)
        probes.set(k, p)
      }
      const mine = await p
      if (mine !== r.output)
        return `\`${r.command}\` answers ${JSON.stringify(mine)} on this worker, ${JSON.stringify(r.output)} on the run's machine, whose answer its key holds`
    }
    return undefined
  }

  const runTask = async (m: RunOrder, free: () => void): Promise<void> => {
    const stop = new AbortController()
    running.set(m.task, stop)
    // Not awaited: the task does not wait on the relay to say it began.
    void me
      .send('orchestrator', { type: 'start', task: m.task, load: load.now() })
      .catch(() => undefined)
    try {
      const differs = await runtimeDiffers(m)
      if (differs !== undefined) {
        ui.print('err', ui.status('error', m.task, differs))
        await reply(m, m.runKey, {
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: `${differs}\n`,
          violations: [],
        })
        return
      }
      for (const d of m.deps) {
        let got = present.get(d.key)
        if (got === undefined) {
          got = artifacts
            .restore(d.key, {
              id: d.task,
              projectDir: path.join(opts.root, d.project),
              command: '',
              outputs: d.outputs,
            })
            .then((log) => {
              if (log === null)
                throw new Error(`${d.task}'s entry ${d.key} is in no cache this worker reads`)
            })
          present.set(d.key, got)
          holds.set(d.key, names(d.project, d.outputs))
          got.catch(() => present.delete(d.key))
        }
        await got
      }
      // An earlier task's files under these outputs would ship as this one's.
      const cleared = await outputFiles(opts.root, m.project, m.outputs)
      for (const [key, held] of holds)
        if (cleared.some(held)) {
          present.delete(key)
          holds.delete(key)
        }
      for (const f of cleared) await rm(path.join(opts.root, f), { force: true })
      // Built here: the walls, real paths and grants are this machine's.
      const sb =
        m.sandbox === undefined
          ? undefined
          : await sandboxRequestFor(
              { projectDir: path.join(opts.root, m.project) },
              m.sandbox.config,
              opts.root,
              m.sandbox.keyed === undefined
                ? undefined
                : new Set(m.sandbox.keyed.map((k) => path.join(opts.root, k))),
              m.nested.map((n) => path.join(opts.root, n)),
            )
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
        ...(sb === undefined ? {} : { sandbox: sb.sandbox }),
        ...(m.servers === undefined
          ? {}
          : {
              servers: m.servers.map((s) => ({
                taskId: s.task,
                command: s.command,
                cwd: path.join(opts.root, s.cwd),
                env: localEnv(s.env, root, opts.root),
                ...(s.readyWhen === undefined ? {} : { readyWhen: s.readyWhen }),
                ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
              })),
            }),
      }
      floor ??= localFloor()
      ui.print('out', ui.status('info', m.task, ui.dim('running')))
      const { outputs: _, ...res } = await floor.execute(req)
      // Its command is done: saving its outputs to the cache is the
      // network's time, and its cores are the next task's (main,
      // 2026-10-23: workers booked 3.7 cores and used 2.4).
      free()
      const took = ui.dim(`${Math.round(res.durationMs)}ms`)
      ui.print(
        'out',
        res.exitCode === 0
          ? ui.status('ok', m.task, took)
          : ui.status('error', m.task, [`exit ${res.exitCode} `, took]),
      )
      // A bind the task never wrote is not its output.
      for (const p of sb?.placeholders ?? [])
        if ((await lstat(p.path).catch(() => undefined))?.size === 0)
          await rm(p.path, { force: true })
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

  // What it holds, every `HELD_EVERY` heartbeats: the orchestrator's lease on each task.
  const held = setInterval(() => {
    if (running.size === 0) return
    void me
      .send('orchestrator', { type: 'held', running: [...running.keys()], load: load.now() })
      .catch(() => undefined)
  }, HELD_EVERY * me.heartbeatMs)
  try {
    for (;;) {
      let messages
      try {
        messages = await me.poll()
      } catch (err) {
        if (err instanceof RelayError && err.status === 410) return 0
        // The relay lost it (silent too long, or restarted): the run gave its
        // tasks to others, so this job has nothing left and is no failure.
        if (err instanceof RelayError && err.status === 404) {
          ui.print(
            'err',
            ui.status('warn', 'vx dte worker', 'the relay no longer knows this worker'),
          )
          return 0
        }
        throw err
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          if ((body as { type?: string }).type === 'closed') return 0
          continue
        }
        const m = body as ToWorker
        if (m.type === 'refused') {
          ui.print('err', ui.status('error', 'vx dte worker', `refused: ${m.reason}`))
          return 1
        }
        if (m.type === 'exit') return 0
        if (m.type === 'cache') facts = m.cache
        else if (m.type === 'welcome') {
          facts = m.cache
          ui.print(
            'out',
            ui.report('vx dte worker', [
              ['worker', ui.id(m.name)],
              ['run', opts.run],
              ['relay', opts.relay],
              ['machine', `${cores} cores · ${gb(memory)}`],
            ]),
          )
        } else if (m.type === 'cancel') {
          running.get(m.task)?.abort()
        } else if (m.type === 'batch') {
          // Every batch of a run names the same orchestrator root.
          root = m.root
          realRoot = m.realRoot
          if (m.sandboxes !== undefined) {
            if (floor === undefined) floor = localFloor(m.sandboxes)
            else await floor.rearm(m.sandboxes)
          }
          for (const t of m.tasks) start(t)
        }
      }
    }
  } catch (err) {
    // The run closed under a poll or an answer: nothing is left for this worker.
    if (err instanceof RelayError && err.status === 410) return 0
    throw err
  } finally {
    clearInterval(held)
    load.stop()
    for (const c of running.values()) c.abort()
    await Promise.all(work)
    await floor?.close()
    await me.leave()
  }
}

/**
 * This machine's load, sampled each second: the cores busy over the last
 * one, from the CPUs' times, and the memory in use.
 */
function loadMeter(): { now: () => Load; stop: () => void } {
  const busy = (): [number, number] => {
    let idle = 0
    let total = 0
    for (const c of os.cpus()) {
      const t = c.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.irq + t.idle
    }
    return [total - idle, total]
  }
  let last = busy()
  let cpu = 0
  const timer = setInterval(() => {
    const next = busy()
    const total = next[1] - last[1]
    if (total > 0) cpu = ((next[0] - last[0]) / total) * os.cpus().length
    last = next
  }, 1_000)
  timer.unref?.()
  return {
    now: () => ({ cpu: Math.round(cpu * 100) / 100, memory: os.totalmem() - available() }),
    stop: () => clearInterval(timer),
  }
}

/** Memory a task can take: Linux's MemAvailable counts the page cache it may reclaim, free memory does not. */
function available(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    if (m !== null) return Number(m[1]) * 1024
  } catch {
    // Not Linux.
  }
  return os.freemem()
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
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
