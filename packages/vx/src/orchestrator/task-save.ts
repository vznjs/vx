// Whether a miss is saved, decided in one place (`saveVerdict`), and what
// each verdict does to the cache and the run's facts (`applySave`).

import { span } from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { Attempts } from './attempts.js'
import { outputsStep, type OwnOutputs } from './attempt-outputs.js'
import {
  keyStillTrue,
  type KeyCheck,
  movedSinceKey,
  noStateWritten,
  type StateStamp,
} from './input-recheck.js'
import { markUnsaved, saveMiss, unsavedOutputBytes } from './miss-save.js'
import type { MissRun } from './miss-run.js'
import { forgetUndeclaredWrites } from './task-process.js'

export type SaveVerdict =
  /**
   * The outputs never landed here: no artifact, no rows. A partial local
   * record (a row with no artifact) is the corrupt-entry shape
   * `restoreOutputs` refuses. The executor's closure is what a later local
   * consumer, or a later eager run, pulls the bytes with; its fetch saves
   * them under the key only when `keyed`: an input edited before the
   * describe filed the edit's bytes under the old key.
   */
  | { kind: 'defer'; materialize?: () => Promise<void>; keyed: boolean }
  /** Passed, planned, and every check after the command held. */
  | { kind: 'save'; own: OwnOutputs }
  /** Ran here and saves nothing, and nothing reads after it: only its outputs' size. */
  | { kind: 'count' }
  /**
   * Ran here and saves nothing (failed, a read-only policy, a tainted
   * upstream, a server that died under it, a key that no longer held), yet
   * it wrote what a save would have marked.
   */
  | { kind: 'mark' }
  /** Not cached on this machine: not cacheable, remote-only or deferred. */
  | { kind: 'none' }

/**
 * The one answer to "may this task save". A pass is saved only when the
 * policy planned it (`TaskPolicy.save`) and, in order, nothing it left
 * running may still write, it wrote no undeclared state, its key still
 * describes its inputs, no server it used died under it, and its outputs
 * are its own. Each check that fails says why; later ones do not run.
 */
export async function saveVerdict(
  m: MissRun,
  ran: Attempts,
  check: KeyCheck,
  stamp: StateStamp,
): Promise<SaveVerdict> {
  const { args, policy } = m
  const passed = ran.exitCode === 0
  if (passed && policy.save && (policy.deferred || ran.result.outputs?.kind === 'deferred')) {
    const materialize =
      ran.result.outputs?.kind === 'deferred' ? ran.result.outputs.materialize : undefined
    if (materialize === undefined) return { kind: 'defer', keyed: false }
    const keyed =
      (await keyStillTrue(m, ran.result, check)) &&
      (await args.serverDiedUnder?.(args.node)) !== true
    return { kind: 'defer', materialize, keyed }
  }
  if (
    passed &&
    policy.save &&
    nothingLeftRunning(m, ran) &&
    noStateWritten(m, stamp) &&
    (await keyStillTrue(m, ran.result, check)) &&
    (await args.serverDiedUnder?.(args.node)) !== true
  ) {
    const own = await m.guard.own()
    if (own !== undefined) return { kind: 'save', own }
  }
  if (!policy.cacheable || policy.remoteOnly || policy.deferred) return { kind: 'none' }
  return args.noDependants === true ? { kind: 'count' } : { kind: 'mark' }
}

/** Carry out `verdict`: whether an entry is in, and an unsaved miss's output bytes. */
export async function applySave(
  m: MissRun,
  ran: Attempts,
  verdict: SaveVerdict,
  check: KeyCheck,
  stamp: StateStamp,
): Promise<{ saved: boolean; unsavedBytes?: number }> {
  const { args, policy, hash, stream, secrets } = m
  const { node } = args
  const nestedProjectDirs = args.outputNestedDirs ?? args.nestedProjectDirs
  const { outputs, wsOutputs } = policy
  const result = ran.result
  switch (verdict.kind) {
    case 'defer':
      if (verdict.materialize !== undefined)
        args.deferred?.register(node.id, {
          materialize: verdict.materialize,
          ...(verdict.keyed ? { hash } : {}),
          entry: {
            taskId: node.id,
            command: m.storedCommand,
            durationMs: result.durationMs,
            stdout: stream.stored(secrets.mask),
            ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
            ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
          },
        })
      return { saved: false }
    case 'save': {
      const { landed } = await outputsStep('save', ran.exitCode, ran.spentMs, () =>
        saveMiss({
          ...verdict.own,
          node,
          hash,
          cache: args.cache,
          log: args.log,
          workspaceRoot: args.workspaceRoot,
          nestedProjectDirs,
          gitFilesCache: args.gitFilesCache,
          outputs,
          wsOutputs,
          captured: m.inputs.captured,
          command: m.storedCommand,
          durationMs: result.durationMs,
          stdout: stream.stored(secrets.mask),
          ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
          ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
          outputDirSnapshots: args.outputDirSnapshots,
          deferSave: args.deferSave,
          // A sink listens: say what the save cost.
          measure: args.explainMiss !== undefined,
          state: stamp.state,
        }),
      )
      // A run that settles the outcome on `landed` learns there whether the
      // entry is in; without one, the save is done (a `--force` save may
      // have kept the entry it found).
      if (args.deferredSaves !== undefined) {
        args.deferredSaves.set(node.id, landed)
        return { saved: false }
      }
      return { saved: (await landed).saved === true }
    }
    case 'count':
      // Nothing reads after it, so nothing to mark: only its row's `outputs`.
      if (ran.exitCode !== 0) return { saved: false }
      return {
        saved: false,
        unsavedBytes: await unsavedOutputBytes({
          node,
          workspaceRoot: args.workspaceRoot,
          nestedProjectDirs,
          outputs,
          wsOutputs,
        }),
      }
    case 'mark': {
      // It may have rewritten an input the re-check before a save catches. A
      // same-run reader keyed from the snapshot's OIDs for either replayed
      // the bytes from before the command. A withheld save already dropped
      // the project; this finds the same move again and drops it again.
      const endCheck = span('miss: recheck inputs')
      const moved = await movedSinceKey(m, result, check)
      endCheck()
      if (moved !== undefined) {
        forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
        return { saved: false }
      }
      return {
        saved: false,
        unsavedBytes: await markUnsaved({
          node,
          workspaceRoot: args.workspaceRoot,
          nestedProjectDirs,
          gitFilesCache: args.gitFilesCache,
          outputs,
          wsOutputs,
        }),
      }
    }
    case 'none':
      return { saved: false }
  }
}

/**
 * A process the shell left behind still held its output when the drain
 * bound cut it, so it may still write outputs: a save now would file a tree
 * the run does not leave, and a hit elsewhere would replay it.
 */
function nothingLeftRunning(m: MissRun, ran: Attempts): boolean {
  if (!ran.leftRunning) return true
  warnOf(m.args.log)(
    `[vx] ${m.args.node.id}: a process it left running may still write its outputs — ` +
      `the result stands, but is not saved; wait for it in the command (\`wait\`)`,
  )
  return false
}
