// A miss's outcome: what its attempts, its re-check and its save add up to,
// and the lines that say why a pass was not saved.

import type {
  OutcomeAttempts,
  OutcomeCache,
  OutcomePlacement,
  OutcomeSandbox,
  OutcomeUsage,
  TaskOutcome,
} from '../graph/index.js'
import { warnOf } from '../report/index.js'
import type { Attempts } from './attempts.js'
import type { KeyCheck } from './input-recheck.js'
import type { MissRun } from './miss-run.js'
import { failedOutputLog } from './output-log.js'
import { misrootedWriteHint, perRunWriteHint, sandboxFix } from '../sandbox/index.js'

export function missOutcome(
  m: MissRun,
  ran: Attempts,
  check: KeyCheck,
  save: { saved: boolean; unsavedBytes?: number },
  wallclock: { startNs: bigint; endNs: bigint },
): TaskOutcome {
  const { args, policy, hash, stream, secrets } = m
  const { node, log } = args
  const { result } = ran
  const violations = m.sandbox.violations
  const exitCode = check.movedFails !== undefined ? 1 : ran.exitCode
  const unkeyed = policy.unkeyedUpstream !== undefined || check.unkeyed
  const { keylessBy } = policy

  if (policy.unkeyedUpstream !== undefined && policy.write && exitCode === 0) {
    warnOf(log)(
      `[vx] ${node.id}: ran over ${policy.unkeyedUpstream.node.id}'s outputs, which its key no longer ` +
        `describes — the result stands, but is not saved`,
    )
  }
  // The footer counted it `not saved` and nothing else said why.
  if (keylessBy !== undefined && policy.write && exitCode === 0) {
    warnOf(log)(
      `[vx] ${node.id}: not saved — its key folds ${keylessBy}, which declares no \`inputs\`, ` +
        `so no later run derives it; declare inputs on ${keylessBy}`,
    )
  }

  const notes =
    violations.length === 0
      ? []
      : [
          perRunWriteHint(violations, node.projectDir, args.run.workspaceRoot),
          misrootedWriteHint(violations, node.projectDir, args.run.workspaceRoot),
        ].filter((n) => n !== undefined)
  const finalViolations = notes.length === 0 ? violations : [...violations, ...notes]
  const keepsWhole = policy.save || args.run.keepRun !== undefined
  const base = { node, exitCode, durationMs: ran.spentMs, hash }
  const outcome: TaskOutcome =
    exitCode === 0
      ? { ...base, status: 'success' }
      : {
          ...base,
          status: 'failed',
          ...(stream.output !== undefined
            ? {
                failedOutput: failedOutputLog(stream.output, keepsWhole, secrets.mask ?? undefined),
              }
            : {}),
          ...(result.timedOut === true ? { timedOut: true as const } : {}),
          ...(check.movedFails !== undefined ? { inputMoved: check.movedFails } : {}),
        }
  outcome.timing = { startNs: wallclock.startNs, endNs: wallclock.endNs }
  if (ran.attempts > 1 || ran.failedAttempts.length > 0) {
    const attempts: OutcomeAttempts = {}
    if (ran.attempts > 1) attempts.count = ran.attempts
    if (ran.failedAttempts.length > 0) {
      attempts.failed = ran.failedAttempts
      attempts.outputs = ran.attemptOutputs
    }
    outcome.attempts = attempts
  }
  const cache: OutcomeCache = {}
  if (m.inputs.described !== undefined)
    cache.inputFiles = m.inputs.captured.reduce((n, c) => (c.kind === 'file' ? n + 1 : n), 0)
  if (m.inputs.inputChanges !== undefined) cache.inputChanges = m.inputs.inputChanges
  if (unkeyed) cache.unkeyed = true
  if (check.drifted !== undefined) cache.driftedInput = check.drifted
  if (keylessBy !== undefined) cache.keylessBy = keylessBy
  if (save.saved) cache.saved = true
  if (save.unsavedBytes !== undefined) cache.outputBytes = save.unsavedBytes
  if (result.outputs?.kind === 'deferred') cache.deferred = true
  if (Object.keys(cache).length > 0) outcome.cache = cache
  if (
    args.run.keepRun !== undefined &&
    (exitCode !== 0 ? args.run.keepRun.failures : !policy.save) &&
    stream.output !== undefined
  )
    outcome.runLog = stream.stored(secrets.mask)
  if (
    result.cpuMs !== undefined ||
    result.peakRssBytes !== undefined ||
    m.load.seen !== undefined
  ) {
    const usage: OutcomeUsage = {}
    if (result.cpuMs !== undefined) usage.cpuMs = result.cpuMs
    if (result.peakRssBytes !== undefined) usage.peakRssBytes = result.peakRssBytes
    if (m.load.seen !== undefined) {
      usage.peakCores = m.load.seen.peakCores
      usage.avgRssBytes = m.load.seen.avgRssBytes
    }
    outcome.usage = usage
  }
  if (result.where !== undefined) {
    const placement: OutcomePlacement = { where: result.where }
    if (result.machine !== undefined) {
      placement.cores = result.machine.cores
      placement.memoryBytes = result.machine.memoryBytes
      if (result.machine.cpuShare !== undefined) placement.cpuShare = result.machine.cpuShare
    }
    outcome.placement = placement
  }
  if (finalViolations.length > 0) {
    const sandbox: OutcomeSandbox = {
      // vx's own notes ride with the lines and are no denial.
      violations: finalViolations.filter((v) => v.hint !== true).length,
      // A denied path is the task's own spelling, a secret in it too.
      lines: finalViolations.map((v) => secrets.text(v.line)),
    }
    const fix = sandboxFix(
      finalViolations,
      node.projectDir,
      args.run.workspaceRoot,
      (t) => secrets.text(t),
      node.config.inputs,
      m.sandbox.upstreamOutputs,
      node.config.outputs,
      args.nestedProjectDirs,
      node.config.exec?.sandbox?.allow?.read,
    )
    if (fix !== undefined) sandbox.fix = fix
    outcome.sandbox = sandbox
  }
  return outcome
}
