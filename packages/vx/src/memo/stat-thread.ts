// Stats of many files on a thread of their own. A warm run proves every
// output file of every hit by a stat, and `statSync` is ~2 µs of the main
// thread each: payload's 14,484 output files were 38 ms of a 170 ms no-op,
// 4 ms asked here (the spawn and the posts), answered while git walks.

/** Numbers per file in an answer: size, mode, mtimeMs, ino, ctimeMs. */
export const STAT_FIELDS = 5

// The thread as source, not a file: a compiled vx carries only its entry
// points' graphs (spawn-off.ts does the same).
const WORKER = `
const { statSync } = require('node:fs')
self.onmessage = (e) => {
  const paths = e.data.paths.split('\\0')
  const out = new Float64Array(paths.length * ${STAT_FIELDS})
  for (let i = 0; i < paths.length; i++) {
    const at = i * ${STAT_FIELDS}
    try {
      const s = statSync(paths[i])
      out[at] = s.size
      out[at + 1] = s.mode
      out[at + 2] = s.mtimeMs
      out[at + 3] = s.ino
      out[at + 4] = s.ctimeMs
    } catch {
      out[at + 1] = NaN
    }
  }
  postMessage({ id: e.data.id, out }, [out.buffer])
}
`

export class StatThread {
  private readonly worker: Worker
  private readonly pending = new Map<number, (stats: Float64Array | undefined) => void>()
  private nextId = 0
  private failed = false

  constructor() {
    const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
    // A run that throws before it waits for the answers must still exit.
    w.unref()
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; out: Float64Array }
      const answer = this.pending.get(m.id)
      this.pending.delete(m.id)
      answer?.(m.out)
    }
    // A thread that could not start or died answers nothing: every file is
    // asked where it always was.
    w.onerror = (e) => {
      e.preventDefault()
      this.failed = true
      for (const answer of this.pending.values()) answer(undefined)
      this.pending.clear()
    }
    this.worker = w
  }

  /**
   * `STAT_FIELDS` numbers per path, each stat'ed in order (a NaN mode: the
   * stat threw), or undefined when the thread failed.
   */
  stat(paths: readonly string[]): Promise<Float64Array | undefined> {
    if (this.failed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const id = this.nextId++
      this.pending.set(id, resolve)
      this.worker.postMessage({ id, paths: paths.join('\0') })
    })
  }

  /** Hold the process open for the answers: one awaited may be the only thing pending. */
  hold(): void {
    this.worker.ref()
  }

  end(): void {
    this.worker.terminate()
  }
}
