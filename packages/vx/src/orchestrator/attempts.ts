// A miss's attempts: up to `1 + retries`, one more for a known flake, none
// after the run stopped or fail-fast tripped.

import type { ExecuteResult } from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { printable } from '../util/index.js'
import { failedOutputLog } from './output-log.js'
import { runAttempt } from './attempt.js'
import type { MissRun } from './miss-run.js'
import { mayWriteFingerprint, undeclaredWriteReach } from './sandbox-request.js'
import { forgetUndeclaredWrites } from './task-process.js'

export interface FailedAttempt {
  endedAt: number
  exitCode: number
  timedOut?: true
}

export interface Attempts {
  /** The attempt that stands: the last, or the one before a withdrawn retry. */
  readonly result: ExecuteResult
  readonly exitCode: number
  readonly attempts: number
  /** What THIS run spent on the task, every attempt. */
  readonly spentMs: number
  readonly failedAttempts: FailedAttempt[]
  /** Each failed attempt's output, beside `failedAttempts`: kept for `vx last --log`. */
  readonly attemptOutputs: string[]
  /** Any attempt's shell left a process running, not only the last one's. */
  readonly leftRunning: boolean
}

/** The attempts that ran, or the outcome when the task ends without one standing. */
export async function runAttempts(
  m: MissRun,
  wallclockStartNs: bigint,
): Promise<Attempts | { outcome: TaskOutcome }> {
  const { args, policy, hash, stream, secrets } = m
  const { node, log } = args
  // Pass or fail, the command may have written where its project's run-start
  // facts describe; a remote executor wrote on its own disk.
  const writeReach =
    args.executor.remote === true ? 'none' : undeclaredWriteReach(node, args.workspaceRoot)
  const writesFingerprint =
    args.executor.remote !== true &&
    mayWriteFingerprint(node, args.workspaceRoot, args.fingerprintWatch?.names ?? [])
  let maxAttempts = policy.maxAttempts
  let prior: { result: ExecuteResult; exitCode: number } | undefined
  let spentMs = 0
  let leftRunning = false
  const failedAttempts: FailedAttempt[] = []
  const attemptOutputs: string[] = []
  const ended = (
    status: 'aborted' | 'skipped',
    exitCode: number,
    durationMs: number,
  ): { outcome: TaskOutcome } => ({
    outcome: {
      node,
      status,
      exitCode,
      durationMs,
      hash,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    },
  })
  for (;;) {
    m.attempt++
    const a = await runAttempt(m, prior, spentMs)
    // Never started: skipped, as fail-fast skips a task not yet dispatched.
    if (a.unbegun) return ended('skipped', 1, 0)
    const result = a.result
    prior = { result, exitCode: a.exitCode }
    if (a.withdrawn) {
      m.attempt--
      failedAttempts.pop()
      attemptOutputs.pop()
      break
    }
    // A failed attempt's leftover may write into the retry's outputs too. It
    // is not killed, as a passing attempt's is not: only the save is
    // withheld (`nothingLeftRunning`), and its dependents' (`args.leftRunning`).
    if (result.leftRunning === true && !leftRunning) {
      leftRunning = true
      args.leftRunning?.(node)
    }
    forgetUndeclaredWrites(args, writeReach)
    if (writesFingerprint) args.fingerprintWatch?.wrote()
    spentMs += result.durationMs

    // An attempt that ended in a shutdown never finished on its own terms:
    // it is aborted, so it is neither cached, counted, shown, nor RETRIED.
    // The RUN stopping is what says so: a child that traps the forwarded
    // SIGINT and exits 0 was cached as a success with its partial outputs.
    // A child that died of SIGINT / SIGTERM while the run was NOT stopping
    // (a supervisor, a `kill` from another shell) is a failure. A terminal's
    // Ctrl-C reaches the child and vx together, and the child's exit can be
    // seen before vx's own handler has run, so a signal death waits one
    // event-loop turn for a pending handler before it is judged; a
    // timeout's SIGTERM is our own deadline and judged now.
    let shutdown = args.stopSignal?.aborted === true
    if (
      !shutdown &&
      (result.signal === 'SIGINT' || result.signal === 'SIGTERM') &&
      !result.timedOut
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      shutdown = args.stopSignal?.aborted === true
    }
    if (shutdown) {
      const out = ended('aborted', a.exitCode, spentMs)
      if (result.where !== undefined) out.outcome.where = result.where
      return out
    }

    // A known flake gets the one retry its config did not ask for; a
    // timeout always fails, and a task whose key names nothing (no cache
    // block, or keyed on a keyless upstream) has no record to know it by.
    if (
      a.exitCode !== 0 &&
      m.attempt === 1 &&
      !policy.retriesSet &&
      result.timedOut !== true &&
      policy.cacheable &&
      policy.keylessBy === undefined &&
      args.failFast?.aborted !== true &&
      args.knownFlaky?.(node, hash) === true
    )
      maxAttempts = 2
    if (a.exitCode === 0 || m.attempt >= maxAttempts || args.failFast?.aborted === true) break
    failedAttempts.push({
      endedAt: Date.now(),
      exitCode: a.exitCode,
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
    })
    // The outcome's SANDBOX VIOLATIONS section is the last attempt's: a
    // retried attempt's refusals go into its own output, kept for
    // `vx last --log`, as the section prints them.
    const refused = new Set<string>()
    let denials = 0
    for (const v of m.sandbox.violations) {
      const line = printable(secrets.text(v.line))
      if (!refused.has(line) && v.hint !== true) denials++
      refused.add(line)
    }
    if (refused.size > 0 && stream.output !== undefined) {
      const section = `${stream.nl()}${denials > 0 ? `SANDBOX VIOLATIONS (${denials})` : 'SANDBOX'}\n${[...refused].join('\n')}\n`
      stream.output.push(section, true)
      log.taskStderr(node, section)
      stream.midLine = false
    }
    attemptOutputs.push(
      stream.output === undefined
        ? ''
        : failedOutputLog(stream.output, true, secrets.mask ?? undefined),
    )
    // The shell's own exit 0 failed only on the refusal: `exit 1` named
    // nothing that happened.
    const why =
      result.timedOut === true
        ? 'a timeout'
        : result.exitCode === 0 && denials > 0
          ? `${denials} sandbox violation${denials === 1 ? '' : 's'}`
          : `exit ${a.exitCode}`
    log.taskStderr(
      node,
      `${stream.nl()}vx: retrying ${node.id} (attempt ${m.attempt + 1}/${maxAttempts}) after ${why}\n`,
    )
  }
  return {
    result: prior.result,
    exitCode: prior.exitCode,
    attempts: m.attempt,
    spentMs,
    failedAttempts,
    attemptOutputs,
    leftRunning,
  }
}
