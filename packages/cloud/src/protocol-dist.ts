// The distributed-execution extension to the core submitter wire
// contract. Core's `@vzn/vx` `ServerMessage`/`ClientMessage` carry only
// the run-submission family (`run` / `event` / `result` / `error`); the
// coordinator↔worker families live here, in `@vzn/vx-cloud`. Cloud's WS
// handlers union the core types with these.
//
// Also carries the JSON-RPC envelope adapters for the `worker.*`/`coord.*`
// method namespaces — the base envelope (events.append / submit.run) stays
// in core; only the distributed mappings live here.

import { type Envelope, type Notification, isNotification, makeNotification } from '@vzn/vx'

/** Minimal task description on the wire (serializable subset of TaskNode). */
export interface WireTaskNode {
  id: string
  projectName: string
  projectDir: string
  taskName: string
  command: string
  env?: Record<string, string | null>
  cacheable: boolean
}

/** Worker-side outcome report. */
export interface WireOutcome {
  status: 'success' | 'failed' | 'skipped' | 'aborted'
  exitCode: number
  durationMs: number
  cacheSource: 'miss' | 'fresh' | 'local' | 'remote'
}

/**
 * Coordinator → worker (distributed execution). Extends the core serve
 * protocol; a plain run-submitter that doesn't speak these ignores them.
 */
export type DistServerMessage =
  | { t: 'task:assign'; node: WireTaskNode; hash: string }
  | { t: 'cache:exists'; hash: string; present: boolean }
  | { t: 'coord:drain' }

/**
 * Worker → coordinator. Worker identity is implicit from the WS
 * connection (one connection per worker).
 */
export type DistClientMessage =
  | { t: 'worker:hello'; workerId: string; capacity: number; labels: readonly string[] }
  | { t: 'worker:pull'; available: number }
  | { t: 'worker:start'; taskHash: string; pid?: number }
  | { t: 'worker:stdout'; taskHash: string; chunk: string }
  | { t: 'worker:stderr'; taskHash: string; chunk: string }
  | { t: 'worker:done'; taskHash: string; outcome: WireOutcome }
  | { t: 'worker:bye'; reason: 'idle-timeout' | 'shutdown' }

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope adapters for the distributed message namespaces.
// The base envelope (events.append / submit.run) lives in core's wire.ts.
// ---------------------------------------------------------------------------

/** Project a coordinator ServerMessage to a `coord.*` notification envelope. */
export function distServerMessageToEnvelope(msg: DistServerMessage): Envelope {
  switch (msg.t) {
    case 'task:assign':
      return makeNotification('coord.assign', { hash: msg.hash, node: msg.node })
    case 'cache:exists':
      return makeNotification('coord.cacheExists', { hash: msg.hash, present: msg.present })
    case 'coord:drain':
      return makeNotification('coord.drain', {})
  }
}

/** Project a `coord.*` notification envelope back to a coordinator ServerMessage. */
export function envelopeToDistServerMessage(env: Envelope): DistServerMessage | null {
  if (!isNotification(env)) return null
  if (env.method === 'coord.assign') {
    const p = env.params as { hash: string; node: WireTaskNode }
    return { t: 'task:assign', hash: p.hash, node: p.node }
  }
  if (env.method === 'coord.cacheExists') {
    const p = env.params as { hash: string; present: boolean }
    return { t: 'cache:exists', hash: p.hash, present: p.present }
  }
  if (env.method === 'coord.drain') {
    return { t: 'coord:drain' }
  }
  return null
}

/** Project a worker ClientMessage to a `worker.*` notification envelope. */
export function distClientMessageToEnvelope(msg: DistClientMessage): Notification {
  switch (msg.t) {
    case 'worker:hello':
      return makeNotification('worker.hello', {
        workerId: msg.workerId,
        capacity: msg.capacity,
        labels: msg.labels,
      })
    case 'worker:pull':
      return makeNotification('worker.pull', { available: msg.available })
    case 'worker:start':
      return makeNotification('worker.start', { taskHash: msg.taskHash, pid: msg.pid })
    case 'worker:stdout':
      return makeNotification('worker.stdout', { taskHash: msg.taskHash, chunk: msg.chunk })
    case 'worker:stderr':
      return makeNotification('worker.stderr', { taskHash: msg.taskHash, chunk: msg.chunk })
    case 'worker:done':
      return makeNotification('worker.done', { taskHash: msg.taskHash, outcome: msg.outcome })
    case 'worker:bye':
      return makeNotification('worker.bye', { reason: msg.reason })
  }
}

/** Project a `worker.*` notification envelope back to a worker ClientMessage. */
export function envelopeToDistClientMessage(env: Envelope): DistClientMessage | null {
  if (!isNotification(env)) return null
  const m = env.method
  const p = env.params as Record<string, unknown>
  if (m === 'worker.hello') {
    return {
      t: 'worker:hello',
      workerId: p.workerId as string,
      capacity: p.capacity as number,
      labels: p.labels as readonly string[],
    }
  }
  if (m === 'worker.pull') return { t: 'worker:pull', available: p.available as number }
  if (m === 'worker.start') {
    const out: DistClientMessage = { t: 'worker:start', taskHash: p.taskHash as string }
    if (p.pid !== undefined) out.pid = p.pid as number
    return out
  }
  if (m === 'worker.stdout')
    return { t: 'worker:stdout', taskHash: p.taskHash as string, chunk: p.chunk as string }
  if (m === 'worker.stderr')
    return { t: 'worker:stderr', taskHash: p.taskHash as string, chunk: p.chunk as string }
  if (m === 'worker.done') {
    return {
      t: 'worker:done',
      taskHash: p.taskHash as string,
      outcome: p.outcome as WireOutcome,
    }
  }
  if (m === 'worker.bye') {
    return { t: 'worker:bye', reason: p.reason as 'idle-timeout' | 'shutdown' }
  }
  return null
}
