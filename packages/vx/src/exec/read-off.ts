// A task's output pipes read on a thread of their own. Bun's reader of a
// pipe allocates about 256 KiB per stream, a silent one included: on the
// main thread that was ~5 GB a cold run of 9,600 tasks and the full GCs it
// drove, each pausing the scheduler. Here the buffers churn in a small heap
// of their own, and the main thread sees only each chunk's bytes.

/**
 * Chunks read ahead of the consumer. The thread reads only on credit, one
 * per chunk the stream is asked for, so a slow consumer stalls the pipe and
 * the task, as a pipe read here did: unpaced, a 3 GB stdout held 1.5 GB in
 * this heap waiting for the logger (vs 100 MB before the thread). 16 drains
 * a 1 GiB pipe as fast as unpaced (1.6 s; 4 took 2.1 s).
 */
const WINDOW = 16

// The worker as source, not a file: a compiled vx carries only its entry
// point's graph (spawn-off.ts).
const WORKER = `
import { closeSync } from 'node:fs'
const live = new Map()
const wake = (l) => { const w = l.wake; l.wake = undefined; w?.() }
// POLLHUP on a pipe's read end: no writer is left anywhere. libc's poll, bound at the first ask.
let hup
const writerLeft = async (fd) => {
  if (hup === undefined) {
    hup = null
    try {
      const { dlopen, FFIType, ptr } = await import('bun:ffi')
      const { symbols } = dlopen('libc.so.6', { poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 } })
      hup = (fd) => {
        const p = new Int32Array(2)
        p[0] = fd
        p[1] = 0x1 // events POLLIN; revents is the high half
        if (symbols.poll(ptr(p), 1, 0) < 0) return true
        return ((p[1] >>> 16) & 0x10) === 0
      }
    } catch {}
  }
  return hup === null ? true : hup(fd)
}
self.onmessage = async (e) => {
  const m = e.data
  if (m.probe !== undefined) { const l = live.get(m.probe); postMessage({ asked: m.ask, left: l === undefined ? false : await writerLeft(l.fd) }); return }
  if (m.more !== undefined) { const l = live.get(m.more); if (l) { l.credit++; wake(l) } return }
  if (m.cancel !== undefined) { const l = live.get(m.cancel); if (l) { l.r.cancel().catch(() => {}); l.credit = Infinity; wake(l) } return }
  const r = Bun.file(m.fd).stream().getReader()
  const l = { r, credit: ${WINDOW}, wake: undefined, fd: m.fd }
  live.set(m.id, l)
  let error
  try {
    for (;;) {
      while (l.credit <= 0) await new Promise((res) => (l.wake = res))
      l.credit--
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
    const m = e.data as {
      id: number
      chunk?: Uint8Array
      done?: true
      error?: string
      asked?: number
      left?: boolean
    }
    if (m.asked !== undefined) {
      asks.get(m.asked)?.(m.left === true)
      asks.delete(m.asked)
      return
    }
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

const ids = new WeakMap<ReadableStream<Uint8Array>, number>()
const asks = new Map<number, (left: boolean) => void>()
let nextAsk = 0

/**
 * Whether anything still holds a write end of the pipe `stream` reads: false
 * once every writer closed (POLLHUP), its bytes still in flight or not, or
 * once the stream ended. Asked of the reader thread, which owns the
 * descriptor until the stream ends, so the number is never another pipe's.
 * True where it cannot tell.
 */
export function writerLeft(stream: ReadableStream<Uint8Array>): Promise<boolean> {
  const id = ids.get(stream)
  if (id === undefined || worker === undefined) return Promise.resolve(true)
  const ask = nextAsk++
  const w = worker
  return new Promise((resolve) => {
    asks.set(ask, resolve)
    w.postMessage({ probe: id, ask })
  })
}

/**
 * `fd`'s bytes as a stream read on the reader thread, which owns `fd` from
 * here and closes it once the stream ends. A cancel settles only once the
 * thread let go of `fd`.
 */
export function readOff(fd: number): ReadableStream<Uint8Array> {
  const w = thread()
  const id = nextId++
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        open.set(id, { c })
        // An open stream holds the run, as a pipe read here does.
        w.ref()
        w.postMessage({ id, fd })
      },
      pull() {
        w.postMessage({ more: id })
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
  ids.set(stream, id)
  return stream
}
