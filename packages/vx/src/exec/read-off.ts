// A task's output pipes read on a thread of their own. Bun's reader of a
// pipe allocates about 256 KiB per stream, a silent one included: on the
// main thread that was ~5 GB a cold run of 9,600 tasks and the full GCs it
// drove, each pausing the scheduler. Here the buffers churn in a small heap
// of their own, and the main thread sees only each chunk's bytes.

// The worker as source, not a file: a compiled vx carries only its entry
// point's graph (spawn-off.ts).
const WORKER = `
import { closeSync } from 'node:fs'
const live = new Map()
self.onmessage = async (e) => {
  const m = e.data
  if (m.cancel !== undefined) { live.get(m.cancel)?.cancel().catch(() => {}); return }
  const r = Bun.file(m.fd).stream().getReader()
  live.set(m.id, r)
  let error
  try {
    for (;;) {
      const { value, done } = await r.read()
      if (done) break
      postMessage({ id: m.id, chunk: value }, [value.buffer])
    }
  } catch (err) {
    error = String(err?.message ?? err)
  }
  live.delete(m.id)
  // The descriptor is this thread's from the hand-off: closed only once its
  // stream ended, as a number closed before the first pull is reused by the
  // next spawn's pipe and read as this one.
  closeSync(m.fd)
  postMessage({ id: m.id, done: true, error })
}
`

let worker: Worker | undefined
let nextId = 0
interface Open {
  c: ReadableStreamDefaultController<Uint8Array>
  /** Set by a cancel: the stream is over once the thread let go of the descriptor. */
  cancelled?: () => void
}
const open = new Map<number, Open>()

function thread(): Worker {
  if (worker !== undefined) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; chunk?: Uint8Array; done?: true; error?: string }
    const o = open.get(m.id)
    if (o === undefined) return
    if (m.chunk !== undefined) {
      if (o.cancelled === undefined) o.c.enqueue(m.chunk)
      return
    }
    open.delete(m.id)
    // An idle thread keeps no run alive.
    if (open.size === 0) w.unref()
    if (o.cancelled !== undefined) o.cancelled()
    else if (m.error !== undefined) o.c.error(new Error(m.error))
    else o.c.close()
  }
  w.unref()
  worker = w
  return w
}

/**
 * `fd`'s bytes as a stream read on the reader thread, which owns `fd` from
 * here and closes it once the stream ends. A cancel settles only once the
 * thread let go of `fd`.
 */
export function readOff(fd: number): ReadableStream<Uint8Array> {
  const w = thread()
  const id = nextId++
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        open.set(id, { c })
        // An open stream holds the run, as a pipe read here does.
        w.ref()
        w.postMessage({ id, fd })
      },
      cancel() {
        const o = open.get(id)
        if (o === undefined) return
        w.postMessage({ cancel: id })
        return new Promise<void>((resolve) => (o.cancelled = resolve))
      },
    },
    { highWaterMark: 0 },
  )
}
