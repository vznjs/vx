import { thrownMessage } from '../util/index.js'
import type { TaskNode } from './task-graph.js'
import type { TaskStatus } from './task-status.js'

/**
 * Thrown by `execute` for a restore-tier task that turned out to have
 * nothing to restore (its artifact vanished after the up-front probe). It
 * may be running ahead of its deps, so it cannot run its command in that
 * slot: the scheduler releases the slot and dispatches it again as an
 * exec-tier task once its deps are done. It records no outcome, and its
 * dependents wait for the second dispatch.
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
 * Thrown by `execute` when vx's own work on a miss's outputs threw: the
 * clean before an attempt, or the save after an exit 0 (a name that is
 * not UTF-8). The outcome keeps `exitCode` and `durationMs` (what the
 * command returned and took so far) and is marked (`outputsFailedOf`),
 * so no label names an exit the command never returned.
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

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  /** Cache key hash, if one was computed. Folded into dependents' keys
   *  (pure-input transitive — the upstream's input key, not its output). */
  hash?: string
  /**
   * For cache-hit statuses: the exec time the ENTRY was stored with — i.e.
   * the work this hit skipped. Distinct from `durationMs`, which is always
   * what THIS run spent (a hit's restore cost). The two differ by whatever
   * the exec:restore ratio happens to be, so a surface reporting "time
   * saved" must read this one; a surface reporting "time spent" must not.
   * Undefined on every non-hit outcome — nothing was skipped.
   */
  storedDurationMs?: number
  /**
   * For cache-hit statuses: what the PRODUCING execution used, read from
   * the entry (it rides the artifact, so a remote hit on a fresh machine
   * carries it too). The same split as `storedDurationMs`: `cpuMs` /
   * `peakRssBytes` are what THIS run spent and stay absent on a hit.
   */
  storedCpuMs?: number
  storedPeakRssBytes?: number
  /**
   * How long an `admit` policy held this task after it was ready with a
   * free worker — the wait the plugin, not the count gate, imposed. Set
   * only when a policy refused it at least once (so a run with no policy
   * carries the field on no outcome); the event stream and the summary
   * footer show it.
   */
  admissionHeldMs?: number
  /**
   * How long this task waited ready (its deps done, or none to wait on)
   * before it was dispatched: a full worker pool's wait, plus any
   * `admissionHeldMs`. Absent when it started within the millisecond and
   * on a task that never ran.
   */
  queuedMs?: number
  /** On a cacheable task that ran: how many files its key read. */
  inputFiles?: number
  /**
   * The artifact's compressed size: on a hit, the entry's; on a miss, the one
   * its save wrote (measured only when a telemetry sink listens).
   */
  artifactBytes?: number
  /**
   * The raw bytes of the task's outputs: on a hit, the entry's files as
   * restored; on a miss, the files its save stored (the row waits for it).
   */
  outputBytes?: number
  /** On a remote hit this run pulled: the download and its ingest. */
  fetchMs?: number
  /** On a miss that saved, with a sink listening: the save's own time. */
  saveMs?: number
  /**
   * On a cacheable task that ran: what its key changed since the last entry
   * saved for it. Only when a telemetry sink asked, and the cache holds one.
   */
  inputChanges?: InputChanges
  /** v11 analytics: CPU time + peak RSS for this task's child process. */
  cpuMs?: number
  peakRssBytes?: number
  /**
   * The most cores one sampling interval burned and the mean resident
   * memory over the looks; only when a sink samples and a look landed.
   */
  peakCores?: number
  avgRssBytes?: number
  /**
   * A GROUP task's own dependency outcomes — the tasks it stands for.
   * A group has no `exec` and therefore no outputs and no cache entry: its
   * hash is a synthetic roll-up (`computeGroupHash`), so asking the local
   * index what it produced returns nothing. A dependent needs the real
   * tasks beneath it to describe its own input set, and only the group
   * itself is ever in a position to say which those are. Set on group
   * outcomes only; never folded into any key.
   */
  groupUpstream?: readonly TaskOutcome[]
  /**
   * This task RAN over inputs its key no longer describes: one moved while
   * it ran, a claimed root file moved, or an upstream carried this
   * mark. Its save was withheld, and its outputs are not what `hash` names,
   * so a dependant that folds `hash` saves nothing either (A-12).
   */
  unkeyed?: true
  /**
   * The input this task's own re-check found moved while it ran (absolute),
   * or null when the key re-derived before the command already differed.
   * The command read a state of it no `vx watch` judgement saw, so the
   * loop counts its next settled state as a change.
   */
  driftedInput?: string | null
  /**
   * The task with no `inputs` this task's key folds (this task, or one
   * upstream): no run can derive that key again, so it neither read nor
   * saved an entry, and a dependant that folds `hash` does neither.
   */
  keylessBy?: string
  /**
   * The run's cache policy read and wrote nothing (`--no-cache`,
   * `--cache-policy=local:`): no cache answered for this task, so a run of it is
   * `no-cache`, not a miss. Set by `run()`; `ranNoCache` reads it.
   */
  cacheOff?: true
  /**
   * On a `skipped` outcome: the task at the ROOT of what blocked it — the
   * failed (or aborted) upstream, followed through any chain of skips
   * between. Absent when the skip was fail-fast's (no upstream failed).
   * The footer, the telemetry record and the run row all
   * read this one field (item 267).
   */
  blockedBy?: string
  /**
   * On an outcome that ran behind a failed dependency (`continueMode:
   * 'always'`), one `--exclude-dependencies` dropped, or a server that died
   * while it ran: the task at the root of it. Its result is not its key's, so no flaky verdict reads it and
   * its run row names the root as a skip's `blockedBy` does. Set by `run()`
   * before any observer (a plugin's `onTaskComplete`) hears the outcome.
   */
  taintedBy?: string
  /**
   * On a `skipped` outcome: its `exec.platforms` leave out this machine.
   * Its dependants are skipped with `blockedBy` naming it, and neither
   * fails the run.
   */
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  /**
   * On a `failed` outcome: vx's own `timeout` killed the final attempt.
   * The exit is the shell's 143, and every label says "timed out" instead
   * of reading it as a signal (item 268).
   */
  timedOut?: true
  /**
   * On a `failed` outcome of a command that ran: the final attempt's
   * output, both streams, as `encodeOutputLog` stores it, secrets masked,
   * bounded to its first 8 KiB and last 56 KiB. The run's history keeps it.
   */
  failedOutput?: string
  /**
   * When the run keeps its bytes in a remote, a task that ran and saved no
   * entry (failed, or uncached): its whole output as `encodeOutputLog`
   * stores it, secrets masked, at the entry's bounds.
   */
  runLog?: string
  /**
   * On a failed persistent task: why it never became ready — the readiness
   * deadline fired, the child exited first (`exitCode` is then its own), or
   * the spawn itself failed. Every label reads this instead of the exit.
   */
  notReady?: 'timeout' | 'exited' | 'spawn'
  /**
   * On a ready persistent task: its child exited on its own while the run
   * went on — a setup step's 0 at ready, a crash's code after it — so no
   * label calls it running.
   */
  serverExit?: number
  /**
   * The input that changed while the command ran, failing the task under
   * `inputs.stability.severity: 'error'` (workspace-relative; '' when vx
   * could not name it). The exit is vx's 1; the label reads this instead.
   */
  inputMoved?: string
  /** Executor-reported placement label (`ExecuteResult.where`) — set only
   *  when the task ran somewhere other than this host: telemetry and the task's row. */
  where?: string
  /** A persistent task each dependant's executor starts where it runs: nothing ran here, and it is no execution of its own. */
  carried?: true
  /** The cores and memory of the machine `where` names (`ExecuteResult.machine`). */
  whereCores?: number
  whereMemoryBytes?: number
  /** `ExecuteResult.machine.cpuShare`: the share of a core its threads got there. */
  cpuShare?: number
  /** `'deferred'` when the task's outputs were left in the remote store
   *  (`--cache-download=none`) instead of landing on this machine. Absent for
   *  every ordinary outcome. Telemetry-only. */
  outputs?: 'deferred'
  /** The task ran here and its result went to the cache. The footer's `↑`. */
  saved?: true
  /**
   * On a `failed` outcome: a cache hit whose restore threw, so no command
   * ran. It counts as failed only, in no cache column: not a miss, not
   * its layer's hit.
   */
  restoreFailed?: true
  /**
   * v11 analytics: hrtime span relative to the parent run's t=0.
   * Lets downstream analytics reconstruct the actual parallel timeline
   * (overlapping tasks, idle gaps) rather than just summing durations.
   */
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
  /**
   * For cache-hit statuses: true if outputs were actually written to
   * disk this run, false if the on-disk state already matched the
   * cached snapshot (no materialization needed). Lets the formatter
   * surface "up-to-date" vs "local-cache" / "remote-cache" in the
   * framed block. Undefined on non-cache-hit outcomes (success /
   * failed / skipped) — irrelevant there.
   */
  restored?: boolean
  /**
   * How many times the task executed this run, when `exec.retries` /
   * `--retries` re-ran failed attempts. Set only when > 1 — a plain
   * single-attempt run carries nothing. Not persisted; telemetry-side
   * flaky detection reads it off the outcome stream.
   */
  attempts?: number
  /** The attempts that failed and were run again, in order: when each ended (epoch ms) and how. */
  failedAttempts?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  /** Each of `failedAttempts`' output, as `failedOutput` encodes it: what `vx last --log` shows. */
  attemptOutputs?: readonly string[]
  /**
   * Set when this run proved the task flaky: its key failed after it had
   * passed (this run's included) or it passed only on a retry. Its row carries it.
   */
  flaky?: { passes: number; failures: number }
  /**
   * Count of sandbox violations captured during this task's exec (a task
   * declaring `exec.sandbox`). Non-zero means the task touched something
   * it did not declare; execute-task fails the task on any violation, so
   * nothing built that way is ever saved or replayed.
   */
  sandboxViolations?: number
  /**
   * Raw violation log lines (one per access denial). Populated alongside
   * `sandboxViolations` so the framed-output renderer can show them
   * inline in the task's block instead of as loose status output.
   */
  sandboxViolationLines?: string[]
  /** The `exec.sandbox.allow` entries that would have granted the denials. */
  sandboxFix?: {
    read?: string[]
    write?: string[]
    network?: string[]
    systemInfo?: string[]
    /** Credential paths denied and left out of the grants: an agent applies the fix as given. */
    withheld?: string[]
    /**
     * Reads of the project the task's `inputs.files` does not match:
     * add them there too when the output depends on them, or a hit replays
     * output built from an older copy. Cached tasks only.
     */
    inputs?: string[]
    /** The same for reads elsewhere in the workspace, as `inputs.workspaceFiles` names them. */
    workspaceFiles?: string[]
  }
}
