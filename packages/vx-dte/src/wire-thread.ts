// The orchestrator's relay participant on a thread of its own.
//
// Liveness is in the protocol: a peer quiet 1.9 heartbeats is lost, and a
// quiet one is probed and acks at once. On the orchestrator's loop, its
// own sync work held those acks: in CI run 40886829588 (2026-10-29) it
// said nothing for 12 s and every worker then running ended, stopping 13
// tasks. Here the socket, its acks, probes and redials run on a thread the
// run's work never holds; the run talks to it by messages.

import { RelayError, type Participant, type RelayMessage } from './wire.js'

/** From the thread: what `wire-host.ts` posts. */
type FromHost =
  | { type: 'token'; n: number }
  | { type: 'messages'; messages: RelayMessage[] }
  | { type: 'resumed'; peer?: string }
  | { type: 'ended'; status: number; message: string }
  | { type: 'done'; n: number; value?: unknown; error?: { status?: number; message: string } }

/** How often this loop says it is alive to the thread (`HELD_BEATS` in wire-host.ts reads it). */
const TICK_MS = 100
/**
 * A tick this late says so: the thread kept the run alive, but what held the
 * loop is not known (run 40886829588's profile had no slice in its 12 s gap),
 * and the line's time in the log is where to look. Half the 2 s heartbeat.
 */
const HELD_SAY_MS = 1000

export async function joinOffLoop(
  relay: string,
  run: string,
  info: unknown,
  token: string | undefined | (() => Promise<string | undefined>),
  extra: Readonly<Record<string, string>> = {},
): Promise<Participant> {
  // [0]: when this loop last ran (Date.now, the clock both threads share); [1]: online.
  const shared = new Float64Array(new SharedArrayBuffer(16))
  const tick = (): void => {
    const now = Date.now()
    const held = now - shared[0]! - TICK_MS
    if (shared[0] && held >= HELD_SAY_MS)
      process.stderr.write(`[vx] dte: this machine's loop was held ${held} ms\n`)
    shared[0] = now
  }
  tick()
  const ticking = setInterval(tick, TICK_MS)
  ticking.unref()
  const thread = new Worker(new URL('./wire-host.ts', import.meta.url).href)
  let n = 0
  const calls = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>()
  const inbox: RelayMessage[] = []
  let ended: RelayError | undefined
  let onResumed: ((peer?: string) => void) | undefined
  /** The token function's own error, said as itself rather than as the thread's copy. */
  let tokenError: unknown
  const waiters = new Set<() => void>()
  const wake = (): void => {
    for (const w of [...waiters]) w()
  }
  const call = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const k = ++n
      calls.set(k, { resolve, reject })
      thread.postMessage({ ...msg, n: k })
    })
  thread.onmessage = (e: MessageEvent<FromHost>) => {
    const m = e.data
    if (m.type === 'token') {
      void (async () => {
        try {
          const value = typeof token === 'function' ? await token() : token
          thread.postMessage({ type: 'token', n: m.n, value })
        } catch (err) {
          tokenError = err
          thread.postMessage({
            type: 'token',
            n: m.n,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    } else if (m.type === 'messages') {
      inbox.push(...m.messages)
      wake()
    } else if (m.type === 'resumed') onResumed?.(m.peer)
    else if (m.type === 'ended') {
      ended ??= new RelayError(m.status, m.message)
      wake()
    } else {
      const c = calls.get(m.n)
      calls.delete(m.n)
      if (m.error === undefined) c?.resolve(m.value)
      else if (tokenError instanceof Error && tokenError.message === m.error.message)
        c?.reject(tokenError)
      else
        c?.reject(
          m.error.status === undefined
            ? new Error(m.error.message)
            : new RelayError(m.error.status, m.error.message),
        )
    }
  }
  const stop = (): void => {
    clearInterval(ticking)
    thread.terminate()
  }
  let joined: { id: string; heartbeatMs: number }
  try {
    joined = (await call({
      type: 'join',
      relay,
      run,
      info,
      extra,
      shared: shared.buffer,
      token: typeof token === 'function' ? undefined : token,
      asks: typeof token === 'function',
    })) as { id: string; heartbeatMs: number }
  } catch (err) {
    stop()
    throw err
  }
  const idle = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done)
      waiters.add(done)
    })
  return {
    id: joined.id,
    heartbeatMs: joined.heartbeatMs,
    get online() {
      return shared[1] === 1
    },
    resumed(f) {
      onResumed = f
    },
    async send(to, body) {
      await call({ type: 'send', to, body })
    },
    async poll(signal) {
      if (inbox.length === 0 && ended === undefined && signal?.aborted !== true)
        await idle(joined.heartbeatMs, signal)
      if (inbox.length > 0) return inbox.splice(0)
      if (ended !== undefined) throw ended
      return []
    },
    async remove(worker) {
      await call({ type: 'remove', worker })
    },
    async leave() {
      try {
        await call({ type: 'leave' })
      } finally {
        stop()
      }
    },
  }
}
