// The thread `joinOffLoop` (wire-thread.ts) starts: the orchestrator's
// participant, its socket, acks, probes and redials, on a loop the run's
// work never holds.

import { join, type Participant } from './wire.js'

declare const self: Worker

/**
 * The run's loop held this many heartbeats (10 s on the default) is taken
 * as hung: the thread leaves, so the relay closes the run and its workers
 * end, as they would have for an orchestrator quiet that long (owner,
 * 2026-10-23: "if it does not reply for 10s its dead").
 */
const HELD_BEATS = 5

let me: Participant | undefined
let n = 0
const tokens = new Map<number, { resolve(v: string | undefined): void; reject(e: Error): void }>()
const post = (m: unknown): void => self.postMessage(m)
const failure = (err: unknown): { status?: number; message: string } => ({
  ...(typeof (err as { status?: unknown }).status === 'number'
    ? { status: (err as { status: number }).status }
    : {}),
  message: err instanceof Error ? err.message : String(err),
})

self.onmessage = async (e: MessageEvent<Record<string, unknown>>) => {
  const m = e.data
  if (m['type'] === 'token') {
    const t = tokens.get(m['n'] as number)
    tokens.delete(m['n'] as number)
    if (typeof m['error'] === 'string') t?.reject(new Error(m['error']))
    else t?.resolve(m['value'] as string | undefined)
    return
  }
  const reply = (value?: unknown): void => post({ type: 'done', n: m['n'], value })
  const fail = (err: unknown): void => post({ type: 'done', n: m['n'], error: failure(err) })
  try {
    if (m['type'] === 'join') {
      const shared = new Float64Array(m['shared'] as SharedArrayBuffer)
      const token = m['asks']
        ? () =>
            new Promise<string | undefined>((resolve, reject) => {
              const k = ++n
              tokens.set(k, { resolve, reject })
              post({ type: 'token', n: k })
            })
        : (m['token'] as string | undefined)
      const p = await join(
        m['relay'] as string,
        m['run'] as string,
        'orchestrator',
        m['info'],
        token,
        m['extra'] as Record<string, string>,
      )
      me = p
      p.resumed((peer) => post({ type: 'resumed', ...(peer === undefined ? {} : { peer }) }))
      reply({ id: p.id, heartbeatMs: p.heartbeatMs })
      const watch = setInterval(
        () => {
          shared[1] = p.online ? 1 : 0
          const held = Date.now() - shared[0]!
          if (held < HELD_BEATS * p.heartbeatMs) return
          clearInterval(watch)
          post({
            type: 'ended',
            status: 410,
            message: `dte: this machine's run was held ${Math.round(held / 1000)} s, past ${HELD_BEATS} heartbeats: the run is over`,
          })
          // quiet: `ended` above already said the run is over; a failed
          // leave changes nothing the relay does with it.
          void p.leave().catch(() => undefined)
        },
        Math.max(10, p.heartbeatMs / 10),
      )
      for (;;) {
        let got
        try {
          got = await p.poll()
        } catch (err) {
          clearInterval(watch)
          const f = failure(err)
          post({ type: 'ended', status: f.status ?? 500, message: f.message })
          return
        }
        if (got.length > 0) post({ type: 'messages', messages: got })
      }
    }
    if (me === undefined) throw new Error('dte: not joined')
    if (m['type'] === 'send') reply(await me.send(m['to'] as string, m['body']))
    else if (m['type'] === 'remove') reply(await me.remove(m['worker'] as string))
    else if (m['type'] === 'leave') reply(await me.leave())
  } catch (err) {
    fail(err)
  }
}
