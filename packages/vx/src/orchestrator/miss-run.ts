// What every step of a miss shares: the task's policy and key, its
// described inputs, and the per-attempt state the request, the attempt and
// the save gate read: its secrets, its output stream and its abort signal.

import type { ExecConfig } from '../config.js'
import {
  BoundedCapture,
  type ExecuteResult,
  type SandboxViolation,
  signalExitCode,
} from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import type { Logger } from '../report/index.js'
import type { Placeholder, WithheldLink } from '../sandbox/index.js'
import {
  heldSecrets,
  killGraceMs,
  maskedStreams,
  secretMask,
  type SecretMask,
} from '../util/index.js'
import type { OutputGuard } from './attempt-outputs.js'
import type { ExecuteArgs } from './execute-task.js'
import { isLocalExecutor } from './local-executor.js'
import type { MissInputs } from './miss-inputs.js'
import { encodeOutputLog, failedOutputHead, failedOutputTail } from './output-log.js'
import { executorLabel } from './plugin-host.js'
import { SIGNAL_SHUTDOWN_GRACE_MS } from './signals.js'
import type { TaskPolicy } from './task-policy.js'
import { taskLogMasks, type TreeLoad } from './telemetry.js'
import type { StateStamps } from './undeclared-state.js'

/** What the last attempt's sandbox request set up, and what it refused. */
export interface AttemptSandbox {
  violations: SandboxViolation[]
  /** The empty files created for a literal write grant; swept after the attempt. */
  placeholders: Placeholder[]
  /** The linked workspace packages withheld: the key does not answer for them. */
  withheld: WithheldLink[]
  /** The dependencies' outputs: a write refused there is granted no fix. */
  upstreamOutputs: string[]
  /** Its executor listed them where it ran: `upstreamOutputs` is read here only after a refusal. */
  listedThere?: boolean
  /**
   * Where this machine's sandbox let the task write (absolute, globs kept):
   * an input changed outside them was not the task's doing. Undefined when
   * unsandboxed or run elsewhere.
   */
  writes: readonly string[] | undefined
}

export interface MissRun {
  readonly args: ExecuteArgs
  readonly policy: TaskPolicy
  readonly hash: string
  readonly inputs: MissInputs
  readonly env: NodeJS.ProcessEnv
  readonly secrets: TaskSecrets
  /**
   * The entry's command is shown by `vx why` and sent with the entry to a
   * remote cache: a value a config interpolated stays out of both.
   */
  readonly storedCommand: string
  readonly stream: AttemptStream
  readonly signal: AttemptSignal
  readonly guard: OutputGuard
  readonly sandbox: AttemptSandbox
  /** The sampling of the attempt's process tree, and what the last one saw. */
  readonly load: { untrack?: (() => TreeLoad | undefined) | undefined; seen?: TreeLoad | undefined }
  /** 1-based, the attempt running now. */
  attempt: number
  /** When the last attempt's command ended, on the file system's clock (`KeyedTasks`). */
  endedAt?: number
  /** The undeclared state stamped before the command: a missing output's line names what survived. */
  state?: StateStamps | undefined
  /** The output globs the last attempt's exit 0 left matching nothing, which failed it. */
  outputsMissing?: readonly string[] | undefined
}

/** The attempt before this one, which stands if this one is withdrawn. */
export interface PriorAttempt {
  readonly result: ExecuteResult
  readonly exitCode: number
}

// The values of a task's secret-named variables, masked in what it prints
// and what the cache keeps of it.
export class TaskSecrets {
  /** Null when the task has no secret. */
  mask: SecretMask | null
  private held: number

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly exec: ExecConfig,
  ) {
    this.mask = this.build()
    this.held = heldSecrets()
  }

  /** Built again once the sandbox started: its proxy token joins them. */
  refresh(): void {
    if (this.held === heldSecrets()) return
    this.held = heldSecrets()
    this.mask = this.build()
  }

  text(t: string): string {
    return this.mask?.mask(t) ?? t
  }

  private build(): SecretMask | null {
    return secretMask([process.env, this.env, this.exec.env?.define], this.exec.env?.secret)
  }
}

// One attempt's output: streamed to the logger chunk by chunk, both streams
// kept in the order they arrived, at the entry's bounds when the task will
// keep it whole (a save, a run log) and as a failure's head and tail else.
export interface StreamSnapshot {
  readonly output: BoundedCapture | undefined
  readonly flushMasked: () => void
}

export class AttemptStream {
  /** The attempt's output as the logger got it (masked). */
  output: BoundedCapture | undefined
  /**
   * The output last ended mid-line: vx's own line (a retry, a timeout, the
   * shell's verdict, an abandoned executor) starts its own, and only then.
   * Glued, a frame read `partialvx: retrying …`.
   */
  midLine = false
  /** The last stderr: the shell's "not found" line names the word a compound command missed. */
  errTail = ''
  /** The last of both streams: a failure's own words name a variable the task was not given (`unpassedEnv`). */
  tail = ''
  /** Ends the masked streams, letting go what they held back. */
  flushMasked: () => void = () => {}

  constructor(
    private readonly node: TaskNode,
    private readonly log: Logger,
  ) {}

  /** A new attempt's capture; returns the request's two callbacks. */
  open(
    whole: boolean,
    secrets: SecretMask | null,
  ): { onStdout: (t: string) => void; onStderr: (t: string) => void } {
    const { node, log } = this
    const kept = whole
      ? new BoundedCapture()
      : new BoundedCapture(failedOutputHead(), failedOutputTail())
    this.output = kept
    this.midLine = false
    this.errTail = ''
    this.tail = ''
    const toOut = (t: string): void => {
      kept.push(t)
      this.tail = (this.tail + t).slice(-4096)
      if (t.length > 0) this.midLine = !t.endsWith('\n')
      log.taskStdout(node, t)
    }
    const toErr = (t: string): void => {
      kept.push(t, true)
      if (t.length > 0) this.midLine = !t.endsWith('\n')
      this.errTail = (this.errTail + t).slice(-2048)
      this.tail = (this.tail + t).slice(-4096)
      log.taskStderr(node, t)
    }
    if (secrets) taskLogMasks.set(node, secrets)
    const masked = secrets && maskedStreams(secrets, toOut, toErr)
    this.flushMasked = () => masked?.end()
    return { onStdout: masked ? masked.out : toOut, onStderr: masked ? masked.err : toErr }
  }

  /** A newline when the output last ended mid-line. */
  nl(): string {
    return this.midLine ? '\n' : ''
  }

  /** Masked again whole: the live stream lets a held piece go after a pause. */
  stored(secrets: SecretMask | null): string {
    return encodeOutputLog(this.output?.chunks() ?? [], secrets ?? undefined)
  }

  snapshot(): StreamSnapshot {
    return { output: this.output, flushMasked: this.flushMasked }
  }

  restore(s: StreamSnapshot): void {
    this.output = s.output
    this.flushMasked = s.flushMasked
  }
}

// The abort signal an attempt's request carries: the run's stop, a plugin
// executor's `exec.timeout`, and fail-fast withdrawing an attempt its
// executor has not yet begun. One per attempt; settled when it ends.
export class AttemptSignal {
  /** The plugin executor's timeout aborted the request. */
  timeoutFired = false
  /**
   * Fail-fast or the run's stop withdrew the attempt while its executor
   * still held it for a machine to begin (`running` answered `null`): it
   * never started.
   */
  unbegun = false
  /** Which withdrew it first: the run's stop ends it not run, fail-fast skips it. */
  unbegunBy: 'stop' | 'failFast' | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private withdrawUnbegun: (() => void) | undefined
  // Taken off once the attempt settles. Left on, every task of the run
  // added one to the run's stop: the list grew to the task count, and each
  // add scans it for a duplicate, ~100 ms of a 1,000-task cold run.
  private unlisten: (() => void) | undefined

  constructor(
    private readonly args: ExecuteArgs,
    private readonly timeout: number | undefined,
  ) {}

  /**
   * A new attempt's signal. It stops a plugin executor on the run's stop
   * and on `exec.timeout`: core cannot kill a process an executor spawned.
   * The local executor keeps its own timer from the spawn (it signals the
   * process group), so its request carries no clock: armed here, it also
   * timed the sandbox's wrap, and a wrap slower than the timeout aborted the
   * request before the spawn. So does an executor that declares `timeouts`.
   */
  request(local: boolean): AbortSignal {
    const { args } = this
    const stop = new AbortController()
    // A stop while a plugin executor still holds the attempt for a machine
    // (`running` answers `null`) ends one that never started: not run, as a
    // task the scheduler never dispatched, not aborted on a machine it never
    // reached (DTE's report named a worker and a time for it).
    const abort = (): void => {
      if (
        !local &&
        !stop.signal.aborted &&
        args.executor.distribution?.running?.(args.node.id) === null
      ) {
        this.unbegun = true
        // Under `--fail-fast` the stop folds fail-fast in: its trip is not a stop.
        this.unbegunBy ??= args.run.failFast?.aborted === true ? 'failFast' : 'stop'
      }
      stop.abort(args.run.stopSignal?.reason)
    }
    this.unlisten?.()
    this.unlisten = undefined
    this.unbegun = false
    this.unbegunBy = undefined
    this.withdrawUnbegun = undefined
    if (args.run.stopSignal?.aborted === true) abort()
    else if (args.run.stopSignal !== undefined) {
      const run = args.run.stopSignal
      run.addEventListener('abort', abort, { once: true })
      this.unlisten = () => run.removeEventListener('abort', abort)
    }
    // `--fail-fast` starts nothing after a failure: a task a plugin
    // executor still holds for a machine is not yet started.
    const failFast = args.run.failFast
    if (!local && failFast !== undefined && args.executor.distribution?.running !== undefined) {
      const withdraw = (): void => {
        if (stop.signal.aborted || args.executor.distribution?.running?.(args.node.id) !== null)
          return
        this.unbegun = true
        this.unbegunBy ??= 'failFast'
        stop.abort(new Error('fail-fast'))
      }
      this.withdrawUnbegun = withdraw
      failFast.addEventListener('abort', withdraw, { once: true })
      const unlisten = this.unlisten
      this.unlisten = () => {
        unlisten?.()
        failFast.removeEventListener('abort', withdraw)
      }
    }
    clearTimeout(this.timer)
    this.timeoutFired = false
    const timeout = this.timeout
    if (timeout !== undefined && !local && args.executor.capabilities?.timeouts !== true) {
      this.timer = setTimeout(() => {
        this.timeoutFired = true
        stop.abort(new Error(`timed out after ${timeout}ms`))
      }, timeout)
    }
    return stop.signal
  }

  /** A failure that landed while the request was built: the executor holds it now. */
  withdraw(): void {
    this.withdrawUnbegun?.()
  }

  /** The attempt ended: its timer and listeners go. */
  settle(): void {
    clearTimeout(this.timer)
    this.unlisten?.()
    this.unlisten = undefined
  }

  /**
   * An executor that ignores `signal` held its task, and so the run, past
   * the stop and past `exec.timeout`. Once the signal aborts it has the kill
   * grace the local executor gives a process group; then core settles the
   * attempt without it and says so. Its work is abandoned: core cannot reach
   * what it started.
   */
  bound(
    running: Promise<unknown>,
    signal: AbortSignal | undefined,
    say: (line: string) => void,
  ): Promise<unknown> {
    const { args } = this
    if (signal === undefined || isLocalExecutor(args.executor)) return running
    const started = performance.now()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<ExecuteResult>((resolve) => {
      onAbort = (): void => {
        const graceMs = killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS)
        graceTimer = setTimeout(() => {
          const why = this.timeoutFired ? `timeout (${this.timeout}ms)` : 'stop'
          say(
            `vx: ${executorLabel(args.executor)} did not return within ${graceMs}ms of the ${why}; abandoned\n`,
          )
          const reason: unknown = signal.reason
          resolve({
            exitCode: signalExitCode(reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'),
            durationMs: Math.round(performance.now() - started),
            stdout: '',
            stderr: '',
            violations: [],
            // What it started may still run and write the retry's outputs.
            leftRunning: true,
            // Its row named this machine: the task was placed on the executor.
            where: args.executor.name,
            ...(this.timeoutFired ? { timedOut: true } : {}),
          })
        }, graceMs)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    // The abandoned call may still settle, or reject, later: nobody awaits it.
    running.catch(() => {})
    return Promise.race([running, abandoned]).finally(() => {
      clearTimeout(graceTimer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    })
  }
}
