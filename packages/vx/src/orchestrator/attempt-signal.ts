// The abort signal an attempt's request carries: the run's stop, a plugin
// executor's `exec.timeout`, and fail-fast withdrawing an attempt its
// executor has not yet begun. One per attempt; settled when it ends.

import { isLocalExecutor, signalExitCode, type ExecuteResult } from '../exec/index.js'
import { killGraceMs } from '../util/index.js'
import type { ExecuteArgs } from './execute-task.js'
import { executorLabel } from './plugin-host.js'
import { SIGNAL_SHUTDOWN_GRACE_MS } from './signals.js'

export class AttemptSignal {
  /** The plugin executor's timeout aborted the request. */
  timeoutFired = false
  /**
   * Fail-fast withdrew the attempt while its executor still held it for a
   * machine to begin (`running` answered `null`): it never started.
   */
  unbegun = false
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
    const abort = (): void => stop.abort(args.stopSignal?.reason)
    this.unlisten?.()
    this.unlisten = undefined
    this.unbegun = false
    this.withdrawUnbegun = undefined
    if (args.stopSignal?.aborted === true) abort()
    else if (args.stopSignal !== undefined) {
      const run = args.stopSignal
      run.addEventListener('abort', abort, { once: true })
      this.unlisten = () => run.removeEventListener('abort', abort)
    }
    // `--continue=never` starts nothing after a failure: a task a plugin
    // executor still holds for a machine is not yet started.
    const failFast = args.failFast
    if (!local && failFast !== undefined && args.executor.running !== undefined) {
      const withdraw = (): void => {
        if (stop.signal.aborted || args.executor.running?.(args.node.id) !== null) return
        this.unbegun = true
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
    if (timeout !== undefined && !local && args.executor.timeouts !== true) {
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
