// The vx ↔ synchronizer ↔ worker wire, v0.
//
// One file so both ends of every message are declared together: a field that
// means one thing to the plugin and another to the worker is the failure this
// arrangement makes impossible to write.
//
// HTTP + JSON, deliberately dull. The synchronizer exists for one structural
// reason — an ephemeral CI job cannot open a connection into a cluster, and a
// worker cannot open one back to a job that may not exist in ten minutes —
// and both ends CAN reach one HTTPS endpoint. Anything cleverer buys nothing
// and costs firewall traversal.

export const WIRE_VERSION = 'v0'

/** What a worker IS, advertised at registration and matched against tasks. */
export interface WorkerCapabilities {
  /** Container image this worker runs, matched against `exec.resources.image`. */
  readonly image?: string
  /** CPU cores available to a task here. */
  readonly cores?: number
  /** Megabytes available to a task here. */
  readonly memory?: number
  /** Assignments this worker takes at once. */
  readonly concurrency: number
}

/** What a task NEEDS, from `exec.resources`. Absent axes constrain nothing. */
export interface Requirement {
  readonly image?: string
  readonly cores?: number
  readonly memory?: number
}

/**
 * A worker satisfies a requirement when it meets EVERY declared axis.
 *
 * Absent on the requirement means "don't care"; absent on the worker means
 * "unknown", which only satisfies a requirement that did not ask. A worker
 * that never said how much memory it has cannot be claimed to have 8 GB —
 * routing a task there anyway would make the declaration a lie, and the
 * failure would surface as an OOM in someone's test rather than as a
 * placement error.
 */
export function satisfies(worker: WorkerCapabilities, need: Requirement): boolean {
  if (need.image !== undefined && worker.image !== need.image) return false
  if (need.cores !== undefined && (worker.cores === undefined || worker.cores < need.cores)) {
    return false
  }
  if (need.memory !== undefined && (worker.memory === undefined || worker.memory < need.memory)) {
    return false
  }
  return true
}

/** `POST /v0/workers` */
export interface RegisterWorkerRequest {
  readonly name: string
  readonly capabilities: WorkerCapabilities
  /** Commit already checked out, if any — the affinity routing reads it. */
  readonly commit?: string
}

export interface RegisterWorkerResponse {
  readonly workerId: string
  readonly token: string
}

/** `POST /v0/runs` */
export interface OpenRunRequest {
  /** The commit every worker on this run checks out. */
  readonly commit: string
  /** Clone URL. Workers fetch this exact commit from it. */
  readonly remote: string
}

export interface OpenRunResponse {
  readonly runId: string
  readonly token: string
}

/** `POST /v0/runs/:id/assignments` — one task, dispatched by vx's scheduler. */
export interface DispatchRequest {
  readonly taskId: string
  readonly project: string
  readonly task: string
  readonly forwardArgs: readonly string[]
  readonly requirement: Requirement
}

export interface DispatchResponse {
  readonly assignmentId: string
}

/** What a worker receives from `GET /v0/work`. */
export interface Assignment {
  readonly assignmentId: string
  readonly runId: string
  readonly taskId: string
  readonly project: string
  readonly task: string
  readonly forwardArgs: readonly string[]
  readonly commit: string
  readonly remote: string
}

/** `POST /v0/assignments/:id/result` */
export interface AssignmentResult {
  readonly exitCode: number
  readonly durationMs: number
  /** Where it ran, for `TaskOutcome.where`. */
  readonly workerId: string
  /** Set when the worker could not run it at all (checkout failed, crash). */
  readonly error?: string
}

/** Events vx receives on `GET /v0/runs/:id/events` (SSE). */
export type RunEvent =
  | {
      readonly kind: 'output'
      readonly assignmentId: string
      readonly stream: 'out' | 'err'
      readonly chunk: string
    }
  | { readonly kind: 'claimed'; readonly assignmentId: string; readonly workerId: string }
  | { readonly kind: 'result'; readonly assignmentId: string; readonly result: AssignmentResult }

/** A worker's own view of a task it is running, for the output endpoint. */
export interface OutputChunk {
  readonly stream: 'out' | 'err'
  readonly chunk: string
}
