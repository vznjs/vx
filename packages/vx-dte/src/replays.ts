// Advice replays the run on eight fleets, each a second or more of one
// core on a 200-task run (main bb5f317), all at the run's end. Played side
// by side, on threads, this machine's cores idle by then: the work is
// split by a shared counter, so this thread plays too and a thread that
// never starts costs nothing.
import os from 'node:os'
import { type PlanTask, type Play, replay, type Replayed, type Size } from './plan/index.js'

/** What a thread is sent: the run, the fleets, and where it writes. */
export interface ReplayJob {
  readonly tasks: readonly PlanTask[]
  readonly fleets: readonly (readonly Size[])[]
  /** Each platform's warm-up, by name ('' for none). */
  readonly warm: Readonly<Record<string, number>>
  /** Int32: [next fleet to take, then per fleet 0 open, 1 played, 2 failed]. */
  readonly state: SharedArrayBuffer
  /** Float64 per fleet: [endMs, heldMs, asked per size]. */
  readonly out: SharedArrayBuffer
}

const OPEN = 0
const PLAYED = 1
const FAILED = 2

/** Plays fleets from `job` until none is left; what `replay-thread.ts` runs too. */
export function takeFleets(job: ReplayJob): void {
  const state = new Int32Array(job.state)
  const out = new Float64Array(job.out)
  const width = 2 + Math.max(0, ...job.fleets.map((f) => f.length))
  for (;;) {
    const z = Atomics.add(state, 0, 1)
    if (z >= job.fleets.length) return
    let done = FAILED
    try {
      const r = replay(job.tasks, job.fleets[z]!, (p) => job.warm[p ?? ''] ?? 0)
      out[z * width] = r.endMs
      out[z * width + 1] = r.heldMs
      out.set(r.asked, z * width + 2)
      done = PLAYED
    } finally {
      Atomics.store(state, 1 + z, done)
      Atomics.notify(state, 1 + z)
    }
  }
}

/** `Play` on this thread and as many more as this machine has cores, each fleet once. */
export function playAside(
  tasks: readonly PlanTask[],
  warm: (platform: string | undefined) => number,
): Play {
  return (fleets) => {
    const platforms = new Set(fleets.flatMap((f) => f.map((s) => s.platform)))
    const job: ReplayJob = {
      tasks,
      fleets,
      warm: Object.fromEntries([...platforms].map((p) => [p ?? '', warm(p)])),
      state: new SharedArrayBuffer(4 * (1 + fleets.length)),
      out: new SharedArrayBuffer(
        8 * fleets.length * (2 + Math.max(0, ...fleets.map((f) => f.length))),
      ),
    }
    const threads: Worker[] = []
    for (let k = 1; k < Math.min(fleets.length, os.availableParallelism()); k++)
      try {
        const w = new Worker(new URL('./replay-thread.ts', import.meta.url).href)
        w.postMessage(job)
        threads.push(w)
      } catch {
        break
      }
    try {
      takeFleets(job)
      const state = new Int32Array(job.state)
      const out = new Float64Array(job.out)
      const width = 2 + Math.max(0, ...fleets.map((f) => f.length))
      return fleets.map((f, z): Replayed => {
        Atomics.wait(state, 1 + z, OPEN)
        // a thread's failure, played here: the error is this thread's to throw
        if (state[1 + z] !== PLAYED) return replay(tasks, f, warm)
        return {
          endMs: out[z * width]!,
          heldMs: out[z * width + 1]!,
          asked: Array.from(out.subarray(z * width + 2, z * width + 2 + f.length)),
        }
      })
    } finally {
      for (const w of threads) w.terminate()
    }
  }
}
