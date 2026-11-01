// A task's spawn on a thread of its own. Bun's spawn holds the calling
// thread until the child has exec'd (vfork), ~0.6 ms a task, and on a cold
// run that thread is the scheduler's: 2,000 tasks with 1.8 ms of the
// scheduler's own work each took 4.96 s spawned there and 3.71 s spawned
// here, the 3.6 s of that work the floor (2026-10-29). The child's
// descriptors are numbers in the one table every thread shares, so its
// pipes are made and read where they were; only the spawn and the wait
// for its exit move.

import type { ResourceUsage } from 'bun'

/** What `runCommand` reads of a child spawned here. */
export interface OffChild {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  resourceUsage(): ResourceUsage | undefined
  kill(signal?: NodeJS.Signals | number): void
  /** Hold the process open from now until the child exits: a spawn with `held: false` does not. */
  hold(): void
}

export interface OffSpawn {
  cmd: string[]
  argv0?: string
  cwd?: string
  env?: Record<string, string>
  /** Each a descriptor number or `'ignore'`: a stream cannot cross threads. */
  stdio: Array<number | 'ignore'>
  detached?: boolean
  /** False: the child keeps no run alive until `hold()` (a spare shell waiting for its task). */
  held?: boolean
}

// The worker as source, not a file: a compiled vx carries only its entry
// point's graph, and a worker file would need an entry point of its own.
const WORKER = `
const live = new Map()
self.onmessage = (e) => {
  const m = e.data
  if (m.kill !== undefined) { live.get(m.kill)?.kill(m.signal); return }
  let p
  try {
    p = Bun.spawn(m.opts.cmd, m.opts)
  } catch (err) {
    postMessage({ id: m.id, error: { message: String(err?.message ?? err), code: err?.code } })
    return
  }
  live.set(m.id, p)
  postMessage({ id: m.id, pid: p.pid })
  p.exited.then(() => {
    live.delete(m.id)
    const u = p.resourceUsage()
    // Its two fields vx reads: the object itself does not cross threads.
    const usage = u === undefined ? undefined : { cpuTime: { user: u.cpuTime.user, system: u.cpuTime.system, total: u.cpuTime.total }, maxRSS: u.maxRSS }
    postMessage({ id: m.id, exitCode: p.exitCode, signalCode: p.signalCode, usage })
  })
}
`

interface Pending {
  held: () => boolean
  spawned: (pid: number) => void
  failed: (err: Error) => void
  exit: (m: {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    usage?: ResourceUsage
  }) => void
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, Pending>()
let liveCount = 0

function thread(): Worker {
  if (worker !== undefined) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data
    const p = pending.get(m.id)
    if (p === undefined) return
    if (m.error !== undefined) {
      pending.delete(m.id)
      const err = new Error(m.error.message) as NodeJS.ErrnoException
      if (m.error.code !== undefined) err.code = m.error.code
      if (p.held()) settleLive(-1)
      p.failed(err)
    } else if (m.pid !== undefined) p.spawned(m.pid)
    else {
      pending.delete(m.id)
      if (p.held()) settleLive(-1)
      p.exit(m)
    }
  }
  // An idle thread keeps no run alive.
  w.unref()
  worker = w
  return w
}

/** Hold the process open while a child spawned here runs, as a spawn on the main thread does. */
function settleLive(delta: number): void {
  liveCount += delta
  if (liveCount > 0) worker?.ref()
  else worker?.unref()
}

/** Spawn `opts` on the spawn thread; resolves once the child is running, rejects when the spawn threw. */
export function spawnOff(opts: OffSpawn): Promise<OffChild> {
  const w = thread()
  const id = nextId++
  let held = opts.held !== false
  if (held) settleLive(1)
  const { held: _, ...spawn } = opts
  return new Promise((resolve, reject) => {
    let exitCode: number | null = null
    let signalCode: NodeJS.Signals | null = null
    let usage: ResourceUsage | undefined
    let onExit!: (code: number) => void
    const exited = new Promise<number>((r) => (onExit = r))
    pending.set(id, {
      held: () => held,
      failed: reject,
      spawned: (pid) =>
        resolve({
          pid,
          exited,
          get exitCode() {
            return exitCode
          },
          get signalCode() {
            return signalCode
          },
          resourceUsage: () => usage,
          kill: (signal) => w.postMessage({ kill: id, signal }),
          hold: () => {
            if (held || exitCode !== null || signalCode !== null) return
            held = true
            settleLive(1)
          },
        }),
      exit: (m) => {
        exitCode = m.exitCode
        signalCode = m.signalCode
        usage = m.usage
        onExit(exitCode ?? 1)
      },
    })
    w.postMessage({ id, opts: spawn })
  })
}
