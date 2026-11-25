// The logger's writes, in order, paced by the streams they reach. A frame
// read back from its file was written piece after piece without a pause, and
// Bun queues what a pipe refuses: a reader slower than vx held the whole
// frame in that queue (+299 MiB for 300 MB of a failed task's output on a
// loaded CI runner). Each write is a step of a job; once a stream refuses
// (`outputPaced`) and QUEUE_CHARS more went out, the rest wait for it to
// drain, so a frame is read from its file only as fast as the reader takes
// it. A stream that never refuses (a file, a test's sink) is written as it
// always was, at once.

import type { OutputWriter } from '../ui/index.js'
import { outputPaced } from '../util/index.js'

/** One write a step; `true` once the job is done. */
export interface Job {
  step(): boolean
}

// Written past a refusal before a wait: waiting at each refusal (64 KiB in
// Bun) cost 300 waits for 20 MB to `cat`, +25-50 ms a warm run of 200 hits.
const QUEUE_CHARS = 1024 * 1024

export interface Paced {
  /** `raw`, each call a job in turn. */
  readonly writer: OutputWriter
  /** `raw` now, for a job's own writes. */
  readonly direct: OutputWriter
  /** `job` after every job before it; now, when none waits. */
  put(job: Job): void
  /** Resolves once every job is done. */
  drained(): Promise<void>
  /** No job waits: a write now goes out in order. */
  readonly idle: boolean
}

/** A job of one step. */
export const once = (fn: () => void): Job => ({
  step() {
    fn()
    return true
  },
})

/** A job stepping `it`: each `yield` after one write. */
export const stepping = (it: Iterator<unknown>): Job => ({ step: () => it.next().done === true })

export function paced(raw: OutputWriter): Paced {
  const jobs: Job[] = []
  let waiting = false
  // Written since the streams last took everything.
  let owed = 0
  const idle: (() => void)[] = []
  const pump = (): void => {
    while (jobs.length > 0) {
      let done = true
      try {
        done = jobs[0]!.step()
      } catch {
        // Observability never breaks a run: a job that threw is dropped.
      }
      if (done) jobs.shift()
      const full = outputPaced()
      if (full === undefined) owed = 0
      else if (owed >= QUEUE_CHARS) {
        waiting = true
        void full.then(() => {
          waiting = false
          owed = 0
          pump()
        })
        return
      }
    }
    for (const resolve of idle.splice(0)) resolve()
  }
  const put = (job: Job): void => {
    jobs.push(job)
    if (!waiting && jobs.length === 1) pump()
  }
  const direct: OutputWriter = {
    enabled: raw.enabled,
    write(chunk) {
      owed += chunk.length
      raw.write(chunk)
    },
    writeTo(target, chunk) {
      owed += chunk.length
      raw.writeTo(target, chunk)
    },
    setStatus: (line, o) => raw.setStatus(line, o),
    setRegion: (lines, o) => raw.setRegion(lines, o),
    settle: () => raw.settle(),
    clearStatus: () => raw.clearStatus(),
    hold: () => raw.hold(),
  }
  // The region set waiting its turn: a later set replaces it, or a wait
  // replayed every redraw of the status line it spanned.
  let region: { draw: () => void; force: boolean } | undefined
  const redraw = (draw: (force: boolean) => void, force = false): void => {
    if (region !== undefined) {
      region.force ||= force
      const f = region.force
      region.draw = () => draw(f)
      return
    }
    const next = { draw: () => draw(force), force }
    region = next
    put(
      once(() => {
        if (region === next) region = undefined
        next.draw()
      }),
    )
  }
  // A clear or settle after a waiting set: a set after it is drawn after it.
  const fence = (fn: () => void): void => {
    region = undefined
    put(once(fn))
  }
  const writer: OutputWriter = {
    enabled: raw.enabled,
    write: (chunk) => put(once(() => direct.write(chunk))),
    writeTo: (target, chunk) => put(once(() => direct.writeTo(target, chunk))),
    setStatus: (line, o) => redraw((force) => raw.setStatus(line, { force }), o?.force),
    setRegion: (lines, o) => redraw((force) => raw.setRegion(lines, { force }), o?.force),
    settle: () => fence(() => raw.settle()),
    clearStatus: () => fence(() => raw.clearStatus()),
    // Now, not in turn: a prompt (a remote's `open`) asks with the region
    // down, and a set still waiting would draw over it.
    hold: () => raw.hold(),
  }
  return {
    writer,
    direct,
    put,
    get idle() {
      return jobs.length === 0 && !waiting
    },
    drained: () =>
      jobs.length === 0 && !waiting ? Promise.resolve() : new Promise((r) => idle.push(r)),
  }
}
