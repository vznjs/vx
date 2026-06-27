// JSON-RPC 2.0 envelope + OTel-LogRecord payload — the wire spec
// committed by docs/design/wire-protocol-2026-06.md. Lives alongside
// the existing protocol.ts (t-discriminated ServerMessage/ClientMessage)
// so vx serve can speak both formats during the transition.
//
// One envelope, three transports (WS / SSE / NDJSON), four channels
// (vx:events / vx:state / vx:rpc / vx:submit). Every external consumer
// that already speaks JSON-RPC works against vx out of the box.
//
// Pure types + a small adapter pair. No transport here; the Hono
// router in src/cli/serve.ts wires the byte frames.

import type { RunRequest, RunResult, ServerMessage, ClientMessage } from './protocol.js'
import type { WireEvent as InternalWireEvent } from './events.js'

/** Protocol version returned by GET /version. */
export const WIRE_PROTOCOL_VERSION = '1.0'

/** The four channels we expose; clients pick the subset they care about. */
export const WIRE_CHANNELS = ['vx:events', 'vx:state', 'vx:rpc', 'vx:submit'] as const
export type WireChannel = (typeof WIRE_CHANNELS)[number]

/** JSON-RPC 2.0 method names emitted by the server (notifications). */
export type ServerNotificationMethod = 'events.append' | 'state.patch'

/** JSON-RPC 2.0 method names dispatched from the client (request/response). */
export type ClientRequestMethod = 'state.snapshot' | 'submit.run' | `rpc.${string}`

/**
 * The JSON-RPC 2.0 envelope. One of four shapes per the spec.
 *
 *   - request:      { jsonrpc, id, method, params? }
 *   - response:     { jsonrpc, id, result }
 *   - error:        { jsonrpc, id, error: { code, message, data? } }
 *   - notification: { jsonrpc, method, params? }
 */
export type Envelope = Request | Response | ErrorResponse | Notification

export interface Request {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface Response {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}

export interface ErrorResponse {
  jsonrpc: '2.0'
  id: number | string
  error: { code: number; message: string; data?: unknown }
}

export interface Notification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 error codes used by vx. The spec reserves -32000..-32099 for impl-defined. */
export const ENVELOPE_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  USER_ERROR: -32000, // a vx UserError — clean message, no stack
  TASK_HASH_UNKNOWN: -32001,
  RUN_NOT_FOUND: -32002,
  UNAUTHORIZED: -32003,
  RATE_LIMITED: -32004,
} as const

/** Build a request envelope. */
export function makeRequest(id: number | string, method: string, params?: unknown): Request {
  const req: Request = { jsonrpc: '2.0', id, method }
  if (params !== undefined) req.params = params
  return req
}

/** Build a notification envelope. */
export function makeNotification(method: string, params?: unknown): Notification {
  const note: Notification = { jsonrpc: '2.0', method }
  if (params !== undefined) note.params = params
  return note
}

/** Build a success response envelope. */
export function makeResponse(id: number | string, result: unknown): Response {
  return { jsonrpc: '2.0', id, result }
}

/** Build an error response envelope. */
export function makeError(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): ErrorResponse {
  const err: ErrorResponse = { jsonrpc: '2.0', id, error: { code, message } }
  if (data !== undefined) err.error.data = data
  return err
}

/** Type-guard: does a parsed object look like an Envelope? */
export function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false
  const v = value as { jsonrpc?: unknown }
  return v.jsonrpc === '2.0'
}

/** Type-guard for a request envelope. */
export function isRequest(env: Envelope): env is Request {
  return 'method' in env && 'id' in env
}

/** Type-guard for a notification envelope (request without id). */
export function isNotification(env: Envelope): env is Notification {
  return 'method' in env && !('id' in env)
}

// ---------------------------------------------------------------------------
// Bidirectional adapters between the legacy t-discriminated wire and the
// JSON-RPC envelope. Lets vx serve accept both formats on the same WS
// endpoint during the transition: parse one, fall back to the other.
// ---------------------------------------------------------------------------

/**
 * Project a ServerMessage to an envelope. Events become `events.append`
 * notifications; results become `submit.run` responses; errors become
 * error responses. The distributed coordinator messages map to the
 * `coord.*` namespace in `@vzn/vx-cloud`'s own adapters.
 */
export function serverMessageToEnvelope(msg: ServerMessage, id?: number | string): Envelope {
  switch (msg.t) {
    case 'event':
      return makeNotification('events.append', msg.event)
    case 'result':
      // submit.run's response. id required from the caller.
      return makeResponse(id ?? 0, msg.result)
    case 'error':
      return makeError(id ?? 0, ENVELOPE_ERRORS.USER_ERROR, msg.message)
  }
}

/**
 * Project an envelope back to a ServerMessage where one exists. Returns
 * null for envelopes that don't have a mapping (e.g. state.snapshot
 * responses — pure JSON-RPC, no submitter form).
 */
export function envelopeToServerMessage(env: Envelope): ServerMessage | null {
  if (isNotification(env) && env.method === 'events.append') {
    return { t: 'event', event: env.params as InternalWireEvent }
  }
  if ('result' in env) {
    return { t: 'result', result: env.result as RunResult }
  }
  if ('error' in env) {
    return { t: 'error', message: env.error.message }
  }
  return null
}

/** Project a ClientMessage to an envelope. `run` becomes a `submit.run` request. */
export function clientMessageToEnvelope(msg: ClientMessage, id?: number | string): Envelope {
  return makeRequest(id ?? 1, 'submit.run', msg.request)
}

/** Project an envelope back to a ClientMessage. */
export function envelopeToClientMessage(env: Envelope): ClientMessage | null {
  if (isRequest(env) && env.method === 'submit.run') {
    return { t: 'run', request: env.params as RunRequest }
  }
  return null
}

// ---------------------------------------------------------------------------
// Transport encoders — single bus, one envelope, three byte framings.
// Helpers exposed for the Hono mounts in src/cli/serve.ts.
// ---------------------------------------------------------------------------

/** Encode an envelope for a WebSocket frame (one JSON object per frame). */
export function encodeForWS(env: Envelope): string {
  return JSON.stringify(env)
}

/**
 * Encode an envelope as an SSE event block. Each block is one
 * `data: <json>\n\n` chunk so a `curl` or browser EventSource gets it
 * cleanly.
 */
export function encodeForSSE(env: Envelope): string {
  return `data: ${JSON.stringify(env)}\n\n`
}

/** Encode an envelope as a NDJSON line. One envelope per line. */
export function encodeForNDJSON(env: Envelope): string {
  return JSON.stringify(env) + '\n'
}

/** Parse a UTF-8 string back to an envelope (and validate the shape). */
export function decodeEnvelope(raw: string): Envelope {
  const value = JSON.parse(raw) as unknown
  if (!isEnvelope(value)) {
    throw new Error(`not a JSON-RPC 2.0 envelope: ${raw.slice(0, 100)}`)
  }
  return value
}
