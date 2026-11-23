// `vx watch` runs a task again only when the change can reach it. A cached
// task had that from its key: a hit. An uncached one (no entry to hit) and a
// cached one that failed (nothing saved) ran on every cycle, whatever the
// edit: editing the app re-ran the uncached generator it builds on
// (turborepo#13347), and an edit to one project re-ran another's failing
// lint. The loop hands each cycle the last result of such a task in this
// watch (`RunHandoff.kept`), and the task keeps it when its key is the one
// it ran under and no path in its project changed since (the loop leaves
// those out): the same inputs, the same command, the same files on disk.

import { isGroupTask, isKeyFailed, outputsFailedOf, type TaskOutcome } from '../graph/index.js'
import type { ExecuteArgs } from './execute-task.js'

/**
 * Whether a cycle's outcome may stand for the next cycles while its key
 * holds: a pass that saved no entry, or a command's failure. Not a result
 * its key does not vouch for (moved, keyless or tainted inputs), a timeout
 * or a proven flake (the next run may differ), nor one vx's own step failed.
 */
export function keepsOutcome(o: TaskOutcome): boolean {
  const { node } = o
  if (isGroupTask(node) || node.config.exec?.persistent !== undefined) return false
  if (o.hash === undefined || o.taintedBy !== undefined || o.attempts?.flaky !== undefined)
    return false
  const c = o.cache
  if (c?.unkeyed === true || c?.keylessBy !== undefined || c?.driftedInput !== undefined)
    return false
  if (o.status === 'success') return node.config.cache !== true || c?.off === true
  return (
    o.status === 'failed' &&
    o.timedOut !== true &&
    o.inputMoved === undefined &&
    o.restoreFailed !== true &&
    o.sandbox === undefined &&
    !isKeyFailed(o) &&
    outputsFailedOf(o) === undefined
  )
}

/**
 * A dependency ran its command this cycle: an uncached one may have rewritten
 * what its dependant reads under the same key (a key folds input keys, never
 * outputs), so nothing built on it is kept.
 */
function ranHere(o: TaskOutcome): boolean {
  if (o.groupUpstream !== undefined) return o.groupUpstream.some(ranHere)
  return (o.status === 'success' || o.status === 'failed') && o.cache?.kept !== true
}

/** The task's kept result from an earlier cycle when its key is the same, else undefined: it runs. */
export function keptOutcome(
  args: ExecuteArgs,
  hash: string,
  startNs: bigint,
): TaskOutcome | undefined {
  const last = args.run.kept?.get(args.node.id)
  if (last === undefined || last.hash !== hash || args.upstream.some(ranHere)) return undefined
  const timing = { startNs, endNs: startNs }
  const cache = { ...last.cache, kept: true as const }
  if (last.status === 'failed')
    return {
      node: args.node,
      status: 'failed',
      exitCode: last.exitCode,
      durationMs: 0,
      hash,
      timing,
      cache,
      ...(last.failedOutput !== undefined ? { failedOutput: last.failedOutput } : {}),
    }
  return { node: args.node, status: 'success', exitCode: 0, durationMs: 0, hash, timing, cache }
}
