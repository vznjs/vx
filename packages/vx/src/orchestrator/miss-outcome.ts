// A miss's outcome: what its attempts, its re-check and its save add up to,
// and the lines that say why a pass was not saved.

import type { TaskOutcome } from '../graph/index.js'
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
  const fixOf = (fix: TaskOutcome['sandboxFix']) => (fix === undefined ? {} : { sandboxFix: fix })
  const keepsWhole = policy.save || args.run.keepRun !== undefined

  return {
    node,
    status: exitCode === 0 ? 'success' : 'failed',
    exitCode,
    durationMs: ran.spentMs,
    hash,
    ...(ran.attempts > 1 ? { attempts: ran.attempts } : {}),
    ...(ran.failedAttempts.length > 0
      ? { failedAttempts: ran.failedAttempts, attemptOutputs: ran.attemptOutputs }
      : {}),
    ...(m.inputs.described !== undefined
      ? { inputFiles: m.inputs.captured.reduce((n, c) => (c.kind === 'file' ? n + 1 : n), 0) }
      : {}),
    ...(m.inputs.inputChanges !== undefined ? { inputChanges: m.inputs.inputChanges } : {}),
    ...(unkeyed ? { unkeyed: true as const } : {}),
    ...(check.drifted !== undefined ? { driftedInput: check.drifted } : {}),
    ...(keylessBy !== undefined ? { keylessBy } : {}),
    ...(save.saved ? { saved: true as const } : {}),
    ...(save.unsavedBytes !== undefined ? { outputBytes: save.unsavedBytes } : {}),
    ...(exitCode !== 0 && stream.output !== undefined
      ? { failedOutput: failedOutputLog(stream.output, keepsWhole, secrets.mask ?? undefined) }
      : {}),
    ...(args.run.keepRun !== undefined &&
    (exitCode !== 0 ? args.run.keepRun.failures : !policy.save) &&
    stream.output !== undefined
      ? { runLog: stream.stored(secrets.mask) }
      : {}),
    ...(result.timedOut === true && exitCode !== 0 ? { timedOut: true as const } : {}),
    ...(check.movedFails !== undefined ? { inputMoved: check.movedFails } : {}),
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    ...(m.load.seen !== undefined
      ? { peakCores: m.load.seen.peakCores, avgRssBytes: m.load.seen.avgRssBytes }
      : {}),
    ...(result.where !== undefined ? { where: result.where } : {}),
    ...(result.where !== undefined && result.machine !== undefined
      ? {
          whereCores: result.machine.cores,
          whereMemoryBytes: result.machine.memoryBytes,
          ...(result.machine.cpuShare === undefined ? {} : { cpuShare: result.machine.cpuShare }),
        }
      : {}),
    ...(result.outputs?.kind === 'deferred' ? { outputs: 'deferred' as const } : {}),
    wallclockStartNs: wallclock.startNs,
    wallclockEndNs: wallclock.endNs,
    ...(finalViolations.length > 0
      ? {
          // vx's own notes ride with the lines and are no denial.
          sandboxViolations: finalViolations.filter((v) => v.hint !== true).length,
          // A denied path is the task's own spelling, a secret in it too.
          sandboxViolationLines: finalViolations.map((v) => secrets.text(v.line)),
          ...fixOf(
            sandboxFix(
              finalViolations,
              node.projectDir,
              args.run.workspaceRoot,
              (t) => secrets.text(t),
              node.config.inputs,
              m.sandbox.upstreamOutputs,
              node.config.outputs,
              args.nestedProjectDirs,
              node.config.exec?.sandbox?.allow?.read,
            ),
          ),
        }
      : {}),
  }
}
