// The client↔service wire contract. A `vx run` client submits a
// `RunRequest`; the service streams `WireEvent`s and returns a
// `RunResult`. Transport-agnostic by design — the same messages travel a
// local unix/ws hop today or a hosted `wss://` link tomorrow. Pure types +
// the RunOptions⇄RunRequest mapping; no transport, no execution here.

import type { CachePolicy } from '../cache/index.js'
import type { ContinueMode } from '../graph/index.js'
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
  cache?: CachePolicy
  continueMode?: ContinueMode
  frozen?: boolean
  /** Run-level retry default (`--retry <n>`); explicit `exec.retries` wins. */
  retries?: number
  flow?: 'focused' | 'broad'
  outputLogs?: 'full' | 'errors-only' | 'none'
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  summarize?: string
  profile?: string
  /** Free-form key/value labels from `--tag`, persisted on the invocation row. */
  tags?: Record<string, string>
  /** The raw `vx run …` command string, recorded on the invocation row. */
  command?: string
}

export interface RunResult {
  ok: boolean
  outcomes: OutcomeView[]
}

/**
 * Where a `vx run` executes. The client submits a serializable
 * `RunRequest` and gets back a `RunResult`; it neither knows nor cares
 * whether the work happened in-process or was delegated to a service.
 * This is the currency of the `backend` plugin capability — part of the
 * public wire contract (it lives here, not in `cli`, so a plugin can
 * reference it without a `cli` import).
 */
export interface RunBackend {
  run(request: RunRequest): Promise<RunResult>
}

/**
 * service → client. The submitter contract: an event stream, a final
 * result, or an error. The distributed-execution variants
 * (`task:assign`/`agent:refused`/`coord:drain`) live in a distribution
 * plugin's protocol module — its WS handler unions this with those.
 */
export type ServerMessage =
  | { t: 'event'; event: WireEvent }
  | { t: 'result'; result: RunResult }
  | { t: 'error'; message: string }

/**
 * client → service. The submitter contract: a run submission. The
 * agent-side `agent:*` family lives in a distribution plugin's protocol
 * module.
 */
export type ClientMessage = { t: 'run'; request: RunRequest }

/** Project resolved `RunOptions` down to the serializable request. */
export function optionsToRequest(options: RunOptions): RunRequest {
  const req: RunRequest = { tasks: options.tasks, cwd: options.cwd }
  if (options.projects !== undefined) req.projects = options.projects
  if (options.concurrency !== undefined) req.concurrency = options.concurrency
  if (options.cache !== undefined) req.cache = options.cache
  if (options.continueMode !== undefined) req.continueMode = options.continueMode
  if (options.frozen !== undefined) req.frozen = options.frozen
  if (options.retries !== undefined) req.retries = options.retries
  if (options.flow !== undefined) req.flow = options.flow
  if (options.outputLogs !== undefined) req.outputLogs = options.outputLogs
  if (options.excludeDependencies !== undefined)
    req.excludeDependencies = options.excludeDependencies
  if (options.forwardArgs !== undefined) req.forwardArgs = options.forwardArgs
  if (options.summarize !== undefined) req.summarize = options.summarize
  if (options.profile !== undefined) req.profile = options.profile
  if (options.tags !== undefined) req.tags = options.tags
  if (options.command !== undefined) req.command = options.command
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
  if (request.cache !== undefined) options.cache = request.cache
  if (request.continueMode !== undefined) options.continueMode = request.continueMode
  if (request.frozen !== undefined) options.frozen = request.frozen
  if (request.retries !== undefined) options.retries = request.retries
  if (request.flow !== undefined) options.flow = request.flow
  if (request.outputLogs !== undefined) options.outputLogs = request.outputLogs
  if (request.excludeDependencies !== undefined) {
    options.excludeDependencies = request.excludeDependencies
  }
  if (request.forwardArgs !== undefined) options.forwardArgs = request.forwardArgs
  if (request.summarize !== undefined) options.summarize = request.summarize
  if (request.profile !== undefined) options.profile = request.profile
  if (request.tags !== undefined) options.tags = request.tags
  if (request.command !== undefined) options.command = request.command
  return options
}
