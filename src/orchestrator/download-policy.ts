// `--download` policy: which tasks may leave their outputs in the remote
// store instead of landing them on this machine, and which must not.
//
// See docs/design/download-policy-cas-cache-2026-08.md. Two decisions live
// here, both made ONCE per run at plan time (never per attempt), so
// `--dry` can show them and the scheduler never re-derives them.

import { isGroupTask, type TaskNode } from '../graph/index.js'
import { staticPrefix } from '../util/index.js'

/** Where a task's outputs go. `never` is `exec.remote: 'only'`. */
export type DownloadMode = 'eager' | 'deferred' | 'never'

/**
 * Deferral eligibility: the tasks whose outputs NO key in this run could
 * observe on disk. Returns the INELIGIBLE ids mapped to the reason, so a
 * downgrade can name itself in `--dry`.
 *
 * The channel this closes is narrow and specific. A dependent's key folds
 * an upstream's KEY, never its output content (pure-input transitive
 * hashing), so deferral cannot move a dependent's key that way. The one
 * real channel is a task whose `cache.inputs` globs can MATCH a producer's
 * declared outputs on disk: then its key differs by whether the bytes
 * arrived.
 *
 * DELIBERATELY TIGHTER than "any task sharing the producer's project"
 * (the shape the design doc first sketched): that rule fires whenever a
 * sibling reads the project at all, which is every ordinary workspace —
 * `test` reads `src/**` while `build` writes `dist/**` — and would leave
 * `--download=none` with nothing to defer. Comparing the globs' static
 * prefixes answers the question actually being asked, and stays
 * conservative in every direction that matters: a leading wildcard yields
 * `.` and reaches everything, a cacheable task with no declared `files`
 * is treated as reading its whole project, and `workspaceFiles` on either
 * side ignores project boundaries — all three force ineligible.
 */
export function deferralEligibility(nodes: Map<string, TaskNode>): Map<string, string> {
  const ineligible = new Map<string, string>()

  const readersByProject = new Map<string, { taskId: string; prefixes: string[] }[]>()
  let workspaceReader: string | undefined
  let runtimeReader: string | undefined
  for (const n of nodes.values()) {
    const cache = n.config.cache
    if (cache === undefined) continue
    if ((cache.inputs?.workspaceFiles?.length ?? 0) > 0) workspaceReader ??= n.id
    // A `runtime` input is a SHELL COMMAND whose reads are unknowable —
    // the same reason vx refuses to infer inputs by tracing. It can `cat` a
    // producer's output (or path-escape its project to do it), and its
    // stdout is folded into the key, so its answer would differ by whether
    // the bytes were fetched. Deferral makes that sharper than it already
    // was: it deliberately skips the output clean, so a stale prior build
    // is exactly what such a command would sample. Nothing defers in a run
    // that declares one — worse than nothing would be a key that moves with
    // a transfer flag.
    if (
      (cache.inputs?.runtime?.length ?? 0) > 0 ||
      (cache.inputs?.workspaceRuntime?.length ?? 0) > 0
    ) {
      runtimeReader ??= n.id
    }
    const files = cache.inputs?.files
    const prefixes = files === undefined || files.length === 0 ? ['.'] : files.map(staticPrefix)
    const list = readersByProject.get(n.projectName)
    if (list) list.push({ taskId: n.id, prefixes })
    else readersByProject.set(n.projectName, [{ taskId: n.id, prefixes }])
  }

  for (const n of nodes.values()) {
    const outputs = n.config.cache?.outputs
    if ((outputs?.workspaceFiles?.length ?? 0) > 0) {
      ineligible.set(
        n.id,
        'declares cache.outputs.workspaceFiles — root-anchored outputs can land where any project-relative input reads',
      )
      continue
    }
    const files = outputs?.files ?? []
    if (files.length === 0) continue
    if (runtimeReader !== undefined) {
      ineligible.set(
        n.id,
        `${runtimeReader} declares a cache.inputs.runtime command, whose reads cannot be bounded`,
      )
      continue
    }
    if (workspaceReader !== undefined) {
      ineligible.set(
        n.id,
        `${workspaceReader} declares cache.inputs.workspaceFiles, which can read any project`,
      )
      continue
    }
    const outPrefixes = files.map(staticPrefix)
    // Project boundaries are hard, so only a SAME-project reader can reach a
    // project-relative output. A task never observes its own outputs — they
    // are excluded from its own key by construction.
    for (const reader of readersByProject.get(n.projectName) ?? []) {
      if (reader.taskId === n.id) continue
      const clash = reader.prefixes.find((ip) => outPrefixes.some((op) => prefixesOverlap(ip, op)))
      if (clash !== undefined) {
        ineligible.set(
          n.id,
          `${reader.taskId} reads ${clash === '.' ? 'the whole project' : clash} with cache.inputs.files`,
        )
        break
      }
    }
  }
  return ineligible
}

/** Could two glob prefixes, anchored at the same dir, name overlapping paths? */
function prefixesOverlap(a: string, b: string): boolean {
  if (a === '.' || b === '.' || a === '' || b === '' || a === '/' || b === '/') return true
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * The effective per-task download mode. `all` (the default) reproduces
 * today's behaviour exactly: every task eager.
 */
export function resolveDownloadModes(args: {
  nodes: Map<string, TaskNode>
  policy: 'all' | 'toplevel' | 'none'
  /** Task ids placed on a LOCAL executor — they write in place. */
  localPlaced: ReadonlySet<string>
  /** Task ids with `exec.remote: 'only'`. */
  remoteOnly: ReadonlySet<string>
}): { modeOf: Map<string, DownloadMode>; downgrades: Map<string, string> } {
  const modeOf = new Map<string, DownloadMode>()
  const downgrades = new Map<string, string>()
  const ineligible = args.policy === 'all' ? new Map() : deferralEligibility(args.nodes)

  for (const n of args.nodes.values()) {
    if (isGroupTask(n)) continue
    if (args.remoteOnly.has(n.id)) {
      modeOf.set(n.id, 'never')
      continue
    }
    if (args.policy === 'all' || args.localPlaced.has(n.id)) {
      modeOf.set(n.id, 'eager')
      continue
    }
    // `toplevel` = the outputs you ASKED for come home; intermediates stay
    // remote. Decided here rather than by materialising at run end: eager
    // materialisation rides each task's own completion, overlapped with the
    // rest of the run, where a run-end batch would serialise every download
    // after the last task finishes.
    if (args.policy === 'toplevel' && n.requested === true) {
      modeOf.set(n.id, 'eager')
      continue
    }
    const reason = ineligible.get(n.id)
    if (reason !== undefined) {
      modeOf.set(n.id, 'eager')
      downgrades.set(n.id, reason)
      continue
    }
    modeOf.set(n.id, 'deferred')
  }
  return { modeOf, downgrades }
}
