// JSON-RPC 2.0 envelope + WireEvent shape per docs/design/wire-protocol-2026-06.md.
// Kept local so this app stays a self-contained compile unit; the canonical
// definitions live in src/orchestrator/events.ts once the consolidation lands.

export type RpcId = number | string

export type RpcRequest<P = unknown> = {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: P
}

export type RpcNotification<P = unknown> = {
  jsonrpc: '2.0'
  method: string
  params?: P
}

export type RpcResponse<R = unknown> = {
  jsonrpc: '2.0'
  id: RpcId
  result: R
}

export type RpcError = {
  jsonrpc: '2.0'
  id: RpcId | null
  error: { code: number; message: string; data?: unknown }
}

export type Envelope =
  | RpcRequest
  | RpcNotification
  | RpcResponse
  | RpcError

export type RunEventKind =
  | 'run:start'
  | 'task:start'
  | 'task:stdout'
  | 'task:stderr'
  | 'task:complete'
  | 'run:status'
  | 'run:end'

export type WireEvent = {
  timeUnixNano: string
  severityNumber: number
  severityText?: string
  body: string
  attributes: Record<string, unknown>
  traceId: string
  spanId?: string
  'vx.kind': RunEventKind
}

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UserError: -32000,
  TaskHashUnknown: -32001,
  RunNotFound: -32002,
  Unauthorized: -32003,
  RateLimited: -32004,
} as const

export function ok<R>(id: RpcId, result: R): RpcResponse<R> {
  return { jsonrpc: '2.0', id, result }
}

export function err(
  id: RpcId | null,
  code: number,
  message: string,
  data?: unknown,
): RpcError {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

export function notify<P>(method: string, params: P): RpcNotification<P> {
  return { jsonrpc: '2.0', method, params }
}

export function isRequest(e: Envelope): e is RpcRequest {
  return 'method' in e && 'id' in e
}
