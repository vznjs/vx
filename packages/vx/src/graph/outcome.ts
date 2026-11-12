import { thrownMessage } from '../util/index.js'
import type { TaskNode } from './task-graph.js'
import type { TaskStatus } from './task-status.js'

/**
 * Thrown by `execute` for a restore-tier task whose artifact vanished after the
 * probe. It may be running ahead of its deps, so it cannot run its command in
 * that slot: the scheduler dispatches it again as an exec-tier task once its
 * deps are done. It records no outcome; its dependents wait.
 */
export class RestoreDemoted extends Error {
  constructor(readonly taskId: string) {
    super(`${taskId}: restore demoted to a run`)
    this.name = 'RestoreDemoted'
  }
}

/**
 * Thrown by `execute` when restoring a cache hit threw (a full disk, a
 * path in the way, a link out of the project). The run reports `error`
 * as any throw, and the failed outcome says `restoreFailed`: a failed
 * task, counted as neither a miss nor a hit.
 */
export class RestoreFailed extends Error {
  constructor(readonly error: unknown) {
    super(thrownMessage(error))
    this.name = 'RestoreFailed'
  }
}

/**
 * Thrown by `execute` when deriving the task's key threw (a runtime probe
 * that exited non-zero, a refused `inputs.env` value). The command never
 * ran: the failed outcome is marked (`isKeyFailed`), and the line says so.
 */
export class KeyFailed extends Error {
  constructor(readonly error: unknown) {
    super(thrownMessage(error))
    this.name = 'KeyFailed'
  }
}

// A mark, not a field: `TaskOutcome` and `RunPlan` are public types. A symbol
// rides a spread copy and never reaches JSON.
const KEY_FAILED = Symbol('keyFailed')

/** Mark a failed outcome (or a plan holding one) as having no derivable key. */
export function markKeyFailed<T extends object>(o: T): T {
  ;(o as Record<symbol, unknown>)[KEY_FAILED] = true
  return o
}

/** Whether `markKeyFailed` marked it: no key, so no command ran and no cache was asked. */
export function isKeyFailed(o: object): boolean {
  return (o as Record<symbol, unknown>)[KEY_FAILED] === true
}

/**
 * Thrown by `execute` when vx's own work on a miss's outputs threw (the clean
 * before an attempt, or the save after exit 0). The outcome keeps `exitCode`
 * and `durationMs` and is marked (`outputsFailedOf`), so no label names an exit
 * the command never returned.
 */
export class OutputsFailed extends Error {
  constructor(
    readonly error: unknown,
    readonly step: OutputsStep,
    readonly exitCode: number,
    readonly durationMs: number,
  ) {
    super(thrownMessage(error))
    this.name = 'OutputsFailed'
  }
}

type OutputsStep = 'clean' | 'save'

// A mark, as KEY_FAILED: `TaskOutcome` is a public type.
const OUTPUTS_FAILED = Symbol('outputsFailed')

/** Mark a failed outcome (or its view) with the output step that failed it. */
export function markOutputsFailed<T extends object>(o: T, step: OutputsStep): T {
  ;(o as Record<symbol, unknown>)[OUTPUTS_FAILED] = step
  return o
}

/** The output step `markOutputsFailed` marked, if any. */
export function outputsFailedOf(o: object): OutputsStep | undefined {
  return (o as Record<symbol, OutputsStep | undefined>)[OUTPUTS_FAILED]
}

/** What moved in a missed task's key since the last entry saved for it. */
export interface InputChanges {
  /** How many components changed, appeared or went. 0: the same key, its entry gone. */
  count: number
  /** The first of them, by kind then name. */
  first: readonly { kind: string; name: string; change: 'changed' | 'added' | 'removed' }[]
}

/** When the task waited, ran and moved bytes, on the run's clock. */
export interface OutcomeTiming {
  /**
   * How long it waited ready (its deps done, or none to wait on) before it
   * was dispatched: a full worker pool's wait, plus `admissionHeldMs`.
   * Absent when it started within the millisecond.
   */
  queuedMs?: number
  /**
   * How long an `admit` policy held it after it was ready with a free
   * worker. Set only when a policy refused it at least once.
   */
  admissionHeldMs?: number
  /** Its span, as hrtime offsets from the run's start: the run's timeline. */
  startNs?: bigint
  endNs?: bigint
  /** On a remote hit this run pulled: the download and its ingest. */
  fetchMs?: number
  /** On a miss that saved, with a sink listening: the save's own time. */
  saveMs?: number
}

/** What this run's execution of the task used; absent on a hit. */
export interface OutcomeUsage {
  cpuMs?: number
  peakRssBytes?: number
  /**
   * The most cores one sampling interval burned and the mean resident
   * memory over the looks; only when a sink samples and a look landed.
   */
  peakCores?: number
  avgRssBytes?: number
}

/** What the cache and the key said of the task. */
export interface OutcomeCache {
  /**
   * On a hit: what the producing execution took and used, read from the
   * entry. `durationMs` and `usage` stay what THIS run spent, so a surface
   * reporting time saved reads this and one reporting time spent does not.
   */
  stored?: { durationMs: number; cpuMs?: number; peakRssBytes?: number }
  /**
   * On a hit: whether outputs were written to disk this run (false: the
   * tree already matched the entry, "up-to-date").
   */
  restored?: boolean
  /** The task ran here and its result went to the cache. The footer's `↑`. */
  saved?: true
  /** On a cacheable task that ran: how many files its key read. */
  inputFiles?: number
  /** The artifact's compressed size: on a hit the entry's, on a miss its save's (a sink listening). */
  artifactBytes?: number
  /** The raw bytes of its outputs: on a hit as restored, on a miss as saved. */
  outputBytes?: number
  /**
   * On a cacheable task that ran: what its key changed since the last entry
   * saved for it. Only when a telemetry sink asked, and the cache holds one.
   */
  inputChanges?: InputChanges
  /**
   * Its outputs were left in the remote store (`--cache-download=none`)
   * instead of landing on this machine.
   */
  deferred?: true
  /**
   * The run's cache policy read and wrote nothing (`--no-cache`): no cache
   * answered, so a run of it is `no-cache`, not a miss.
   */
  off?: true
  /**
   * It ran over inputs its key no longer describes (an input moved while it
   * ran, or an upstream carried this mark): its save was withheld, and a
   * dependant that folds `hash` saves nothing either.
   */
  unkeyed?: true
  /**
   * The input its own re-check found moved while it ran (absolute), or null
   * when the key re-derived before the command already differed. `vx watch`
   * counts its next settled state as a change.
   */
  driftedInput?: string | null
  /**
   * The task with no `inputs` its key folds (itself, or one upstream): no
   * run can derive that key again, so it neither read nor saved an entry,
   * and a dependant that folds `hash` does neither.
   */
  keylessBy?: string
}

/** A sandboxed task's denials (`exec.sandbox`): any one fails the task. */
export interface OutcomeSandbox {
  violations: number
  /** One per access denial, shown in the task's block. */
  lines?: string[]
  /** The `exec.sandbox.allow` entries that would have granted the denials. */
  fix?: SandboxFix
}

export interface SandboxFix {
  read?: string[]
  write?: string[]
  network?: string[]
  systemInfo?: string[]
  /** Credential paths denied and left out of the grants: an agent applies the fix as given. */
  withheld?: string[]
  /**
   * Reads of the project its `inputs.files` does not match: add them there
   * too when the output depends on them, or a hit replays output built from
   * an older copy. Cached tasks only.
   */
  inputs?: string[]
  /** The same for reads elsewhere in the workspace, as `inputs.workspaceFiles` names them. */
  workspaceFiles?: string[]
}

/** Its retries (`exec.retries`, `--retries`, a known flake's one more). */
export interface OutcomeAttempts {
  /** How many times it executed this run; set only when more than one. */
  count?: number
  /** The attempts that failed and were run again, in order: when each ended (epoch ms) and how. */
  failed?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  /** Each failed attempt's output, as `failedOutput` encodes it: what `vx last --log` shows. */
  outputs?: readonly string[]
  /**
   * This run proved it flaky: its key failed after it had passed (this run's
   * included) or it passed only on a retry.
   */
  flaky?: { passes: number; failures: number }
}

/** Where an executor ran it, when that is not this host (`ExecuteResult.where`, `.machine`). */
export interface OutcomePlacement {
  where?: string
  /** A persistent task each dependant's executor starts where it runs: nothing ran here. */
  carried?: true
  cores?: number
  memoryBytes?: number
  /** The share of a core its threads got there. */
  cpuShare?: number
}

/** What every outcome has, whatever its status. A group exists only when it holds a value. */
interface OutcomeBase {
  node: TaskNode
  /** What THIS run spent on it: a hit's restore, a miss's execution. */
  durationMs: number
  timing?: OutcomeTiming
  usage?: OutcomeUsage
  cache?: OutcomeCache
  sandbox?: OutcomeSandbox
  attempts?: OutcomeAttempts
  placement?: OutcomePlacement
  /**
   * A GROUP task's own dependency outcomes, the tasks it stands for: a group
   * has no exec, outputs or entry, so a dependent reads the real tasks
   * beneath it to describe its own input set. Never folded into any key.
   */
  groupUpstream?: readonly TaskOutcome[]
  /**
   * It ran behind a failed dependency (`continueMode: 'always'`), one
   * `--exclude-dependencies` dropped, or a server that died while it ran:
   * the task at the root of it. Its result is not its key's, so no flaky
   * verdict reads it.
   */
  taintedBy?: string
  /**
   * When the run keeps its bytes in a remote, a task that ran and saved no
   * entry: its whole output as `encodeOutputLog` stores it, secrets masked.
   */
  runLog?: string
}

/** It started: a command ran, a hit restored, or the run stopped it. */
interface StartedOutcome extends OutcomeBase {
  exitCode: number
  /**
   * Its key, if one was computed. Folded into dependents' keys (the
   * upstream's input key, not its output).
   */
  hash?: string
}

/** Why a failed outcome failed, beyond its exit. */
interface FailureFacts {
  /** vx's own `timeout` killed the final attempt (the shell's 143). */
  timedOut?: true
  /**
   * A persistent task that never became ready: the deadline fired, the
   * child exited first (`exitCode` is then its own), or the spawn failed.
   */
  notReady?: 'timeout' | 'exited' | 'spawn'
  /**
   * The input that changed while the command ran, failing it under
   * `inputs.stability.severity: 'error'` (workspace-relative; '' when vx
   * could not name it). The exit is vx's 1.
   */
  inputMoved?: string
  /** A cache hit whose restore threw: no command ran, and it is in no cache column. */
  restoreFailed?: true
  /**
   * The final attempt's output, both streams, as `encodeOutputLog` stores
   * it, secrets masked, bounded to its first 8 KiB and last 56 KiB.
   */
  failedOutput?: string
}

/** Why a task never ran, or ran no further. */
interface BlockFacts {
  /**
   * The task at the root of what blocked it, followed through any skips. Absent
   * when fail-fast or the run's stop did.
   */
  blockedBy?: string
}

/** Why a task was skipped by platform. */
interface PlatformFacts {
  /** Its `exec.platforms` leave out this machine. */
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  /** It, or the task it is blocked behind, is a platform skip: it fails nothing. */
  platform?: true
}

/** The fields a variant cannot carry: read as undefined on the union. */
type None<T> = { [K in keyof T]?: never }

export interface SucceededOutcome
  extends StartedOutcome, None<FailureFacts>, None<BlockFacts>, None<PlatformFacts> {
  status: Exclude<TaskStatus, 'failed' | 'aborted' | 'skipped'>
  /**
   * A ready persistent task whose child exited on its own while the run
   * went on, so no label calls it running.
   */
  serverExit?: number
}

export interface FailedOutcome
  extends StartedOutcome, FailureFacts, None<BlockFacts>, None<PlatformFacts> {
  status: 'failed'
  serverExit?: never
}

/**
 * A shutdown (SIGINT/SIGTERM) stopped it, or stopped the run before it
 * began: it never finished on its own terms. `exitCode` is the signal's,
 * which the run's history keeps.
 */
export interface AbortedOutcome
  extends StartedOutcome, None<FailureFacts>, BlockFacts, None<PlatformFacts> {
  status: 'aborted'
  /** A server the session's end stopped, whose child had exited on its own before. */
  serverExit?: number
}

/** It never started, so it has no exit; a key only when fail-fast stopped it after deriving one. */
export interface SkippedOutcome extends OutcomeBase, None<FailureFacts>, BlockFacts, PlatformFacts {
  status: 'skipped'
  exitCode?: never
  /** Its key, when fail-fast stopped it after the key was derived and before its command began. */
  hash?: string
  serverExit?: never
}

export type TaskOutcome = SucceededOutcome | FailedOutcome | AbortedOutcome | SkippedOutcome

/**
 * The exit a record or a wire view writes for an outcome: a skip has none of
 * its own, so it reads as the run sees it, 0 behind a platform skip, else 1.
 */
export function exitCodeOf(o: TaskOutcome): number {
  if (o.status !== 'skipped') return o.exitCode
  return o.platform === true ? 0 : 1
}
