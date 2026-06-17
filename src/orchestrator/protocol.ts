// The client↔service wire contract. A `vx run` client submits a
// `RunRequest`; the service streams `WireEvent`s and returns a
// `RunResult`. Transport-agnostic by design — the same messages travel a
// local unix/ws hop today or a hosted `wss://` link tomorrow. Pure types +
// the RunOptions⇄RunRequest mapping; no transport, no execution here.

import type { OutcomeView, WireEvent } from './events.js'
import type { RunOptions } from './options.js'

/**
 * The serializable subset of `RunOptions` a client sends to the service.
 * Omits the non-serializable / host-side fields (`log`, `bus`,
 * `handleSignals`) — those are the service's concern.
 */
export interface RunRequest {
  tasks: readonly string[]
  cwd: string
  projects?: readonly string[]
  concurrency?: number
  noCache?: boolean
  frozen?: boolean
  flow?: 'focused' | 'broad'
  outputLogs?: 'full' | 'errors-only' | 'none'
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  summarize?: string
  profile?: string
}

export interface RunResult {
  ok: boolean
  outcomes: OutcomeView[]
}

/** service → client. */
export type ServerMessage =
  | { t: 'event'; event: WireEvent }
  | { t: 'result'; result: RunResult }
  | { t: 'error'; message: string }

/** client → service. */
export type ClientMessage = { t: 'run'; request: RunRequest }

/** Project resolved `RunOptions` down to the serializable request. */
export function optionsToRequest(options: RunOptions): RunRequest {
  const req: RunRequest = { tasks: options.tasks, cwd: options.cwd }
  if (options.projects !== undefined) req.projects = options.projects
  if (options.concurrency !== undefined) req.concurrency = options.concurrency
  if (options.noCache !== undefined) req.noCache = options.noCache
  if (options.frozen !== undefined) req.frozen = options.frozen
  if (options.flow !== undefined) req.flow = options.flow
  if (options.outputLogs !== undefined) req.outputLogs = options.outputLogs
  if (options.excludeDependencies !== undefined)
    req.excludeDependencies = options.excludeDependencies
  if (options.forwardArgs !== undefined) req.forwardArgs = options.forwardArgs
  if (options.summarize !== undefined) req.summarize = options.summarize
  if (options.profile !== undefined) req.profile = options.profile
  return req
}

/**
 * Rebuild `RunOptions` from a request, for the side that actually executes
 * (the local backend, or the service). The caller adds the host-side
 * fields it needs (`bus`, `log`, `handleSignals`).
 */
export function requestToOptions(request: RunRequest): RunOptions {
  const options: RunOptions = { cwd: request.cwd, tasks: [...request.tasks] }
  if (request.projects !== undefined) options.projects = [...request.projects]
  if (request.concurrency !== undefined) options.concurrency = request.concurrency
  if (request.noCache !== undefined) options.noCache = request.noCache
  if (request.frozen !== undefined) options.frozen = request.frozen
  if (request.flow !== undefined) options.flow = request.flow
  if (request.outputLogs !== undefined) options.outputLogs = request.outputLogs
  if (request.excludeDependencies !== undefined) {
    options.excludeDependencies = request.excludeDependencies
  }
  if (request.forwardArgs !== undefined) options.forwardArgs = request.forwardArgs
  if (request.summarize !== undefined) options.summarize = request.summarize
  if (request.profile !== undefined) options.profile = request.profile
  return options
}
