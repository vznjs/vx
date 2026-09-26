// What a HIT leaves behind: the outputs of a confirmed cache entry
// materialised in the project — or proved already current and left alone —
// the exact changed paths marked so a same-project consumer need not
// re-spawn git, the stored stdout replayed, and the cache-hit outcome
// built. There is ONE restore path: `executeCachedTask` and the local
// short-circuit (a stable hit restored ahead of its deps) both come here,
// so the two cannot drift. Stale-hit-critical: a line moved here changes
// which bytes a green run replays. Moved out of execute-task.ts
// 2026-09-10 as pure code motion, the mirror of miss-save.ts.

import path from 'node:path'
import type { CacheConfig } from '../config.js'
import {
  type CacheEntry,
  cleanOutputPaths,
  cleanOutputs,
  cleanWorkspaceOutputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { asTrees, span, taskGlob, wholeSubtreePrefixes } from '../util/index.js'
import type { ExecuteArgs } from './execute-task.js'

export interface RestoreHitArgs {
  args: ExecuteArgs
  hash: string
  hit: CacheEntry
  /** `performance.now()` when the cache op (probe) started — the
   *  user-perceived restore duration is measured from here. */
  cacheOpStart: number
  /** ns offset from run start for the outcome's wallclock window. */
  taskStartNs: bigint
}

/**
 * Materialize a confirmed cache hit: decide skip-restore, clean +
 * restore declared outputs, mark the exact changed paths so downstream
 * same-project tasks needn't re-spawn git, replay stored stdout, and
 * build the cache-hit `TaskOutcome`. Extracted from `executeCachedTask`
 * so the local short-circuit can restore a stable-key hit ahead of the
 * schedule using the IDENTICAL logic — there is one restore path, not
 * two that could drift.
 */
export async function restoreHit(restore: RestoreHitArgs): Promise<TaskOutcome> {
  const { args, hash, hit, cacheOpStart, taskStartNs } = restore
  const { node, log } = args
  const cacheCfg: CacheConfig | undefined = node.config.cache
  const outputs = cacheCfg?.outputs.files ?? []
  const wsOutputs = cacheCfg?.outputs.workspaceFiles ?? []
  const anyOutputs = outputs.length > 0 || wsOutputs.length > 0
  const dirPrefixes = wholeSubtreePrefixes(outputs)
  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }
  const wsCleanArgs = { workspaceRoot: args.workspaceRoot, outputs: wsOutputs }
  // The two sides of an overlapping pair (item 588). An ADDITIVE task owns
  // only its recorded rows: its glob also selects the upstream's files it
  // adds beside, so "no strays" is not a claim it can make, and its clean
  // takes the rows, never the glob. The UPSTREAM ignores what its
  // dependants declare they add when it judges its own tree current — an
  // addition below is not a stray — while its glob clean still takes them:
  // the dependant restores or runs after it, by the edge.
  const additive = (node.addsToOutputsOf?.length ?? 0) > 0
  const addedGlobs = (node.outputsAddedToBy ?? [])
    .flatMap((g) => asTrees([g]))
    .map((g) => taskGlob(g))
  const isAddition = (rel: string): boolean => addedGlobs.some((g) => g.match(rel))

  // "Tree is already current" short-circuit — skip cleanOutputs
  // + restoreOutputs when the on-disk state matches what this
  // entry recorded at save time. Integrity-preserving: we
  // require BOTH that the output-glob walk yields exactly the
  // expected paths (no strays, no missing) AND that every file's
  // (size, mode, mtime) matches the stored fingerprint. Any
  // divergence falls through to a real clean + restore.
  //
  // The output-file fingerprints can't be batch-loaded at
  // prepareRun time — non-leaf task hashes depend on upstream
  // outputs that haven't been written yet, so hashes are
  // necessarily computed mid-run. The short-circuit's batched probe
  // loads the rows with the entry (`hit.outputRows`); only the lazy
  // path pays one SELECT here. Either beats reading the manifest from
  // the tar (decompress + parse) at the same point.
  // A task with no declared outputs has nothing to clean or restore: its
  // stdout replays from the row (`hit.stdout`), and its artifact holds
  // only logs. Extracting it anyway cost an `exists` + a tar read per hit
  // — 1.7 ms each on a four-task real repo whose `link` and `element`
  // tasks declare `outputs: []` (2026-09-10, VX_TIMING).
  let skipRestore = !anyOutputs
  if (anyOutputs) {
    const endRows = span('output rows')
    const expected = hit.outputRows ?? args.cache.loadOutputFilesBatch([hash]).get(hash) ?? []
    endRows()
    if (expected.length > 0) {
      // Two namespaces in the rows: bare rels are project outputs,
      // `workspace-outputs/<rel>` rows anchor at the workspace root.
      const projExpected = expected.filter((e) => !e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
      const wsExpected = expected
        .filter((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
        .map((e) => ({ ...e, path: e.path.slice(WORKSPACE_OUTPUT_PREFIX.length) }))
      // The directory short-circuit: for whole-subtree globs, unchanged
      // mtimes on every directory recorded at the last save/restore prove
      // the output SET is unchanged (a file added or removed anywhere the
      // glob could see bumps a recorded directory), so the walk that cost
      // 0.36 ms per warm hit is replaced by a few stats. The per-file
      // fingerprint check below still runs; only the enumeration is skipped.
      let setKnown = false
      if (dirPrefixes !== null && wsOutputs.length === 0 && args.cache.outputDirsCurrent) {
        const endDirs = span('output dirs')
        // Loaded with the entry (batched by getMany, or with the lazy get).
        const dirRows = hit.outputDirRows ?? []
        // Rows are recorded for these same prefixes under this same key
        // (the outputs are folded into it), so `covers` cannot be false
        // today — deleting it reddens nothing (item 638). Kept: a row
        // set that shrank would otherwise vouch for a tree it never saw,
        // and the failure it would let through is a skipped restore.
        const covers = dirPrefixes.every((pre) => dirRows.some((r) => r.path === pre))
        setKnown = covers && (await args.cache.outputDirsCurrent!(node.projectDir, dirRows))
        endDirs()
      }
      let actualAbs: string[]
      let actualWsAbs: string[]
      if (setKnown) {
        actualAbs = projExpected.map((e) => path.join(node.projectDir, e.path))
        actualWsAbs = []
      } else {
        const endGlob = span('output glob')
        actualAbs = await resolveOutputs({
          projectDir: node.projectDir,
          outputs,
          nestedProjectDirs: args.nestedProjectDirs,
        })
        actualWsAbs = await resolveWorkspaceOutputs({
          workspaceRoot: args.workspaceRoot,
          outputs: wsOutputs,
        })
        endGlob()
      }
      const setsMatch = (
        actual: readonly string[],
        exp: ReadonlyArray<{ path: string }>,
      ): boolean => {
        const expSet = new Set(exp.map((e) => e.path))
        return actual.length === expSet.size && actual.every((r) => expSet.has(r))
      }
      // A stray a dependant's glob could have added is not a stray; a path
      // this entry recorded is never dropped, even where that glob covers
      // the whole tree (strapi's shape: both on `dist`).
      const expectedRels = new Set(projExpected.map((e) => e.path))
      const expectedWsRels = new Set(wsExpected.map((e) => e.path))
      const actualRels = actualAbs
        .map((p) => path.relative(node.projectDir, p).split(path.sep).join('/'))
        .filter((rel) => expectedRels.has(rel) || !isAddition(rel))
      const actualWsRels = actualWsAbs
        .map((p) => path.relative(args.workspaceRoot, p).split(path.sep).join('/'))
        .filter((rel) => expectedWsRels.has(rel) || !isAddition(rel))
      const rowsPresent = (
        actual: readonly string[],
        exp: ReadonlyArray<{ path: string }>,
      ): boolean => {
        const have = new Set(actual)
        return exp.every((e) => have.has(e.path))
      }
      const treeMatches = additive
        ? rowsPresent(actualRels, projExpected) && rowsPresent(actualWsRels, wsExpected)
        : setsMatch(actualRels, projExpected) && setsMatch(actualWsRels, wsExpected)
      if (treeMatches) {
        const endStat = span('output stat')
        skipRestore =
          (await args.cache.isOutputsCurrent(node.projectDir, projExpected)) &&
          (await args.cache.isOutputsCurrent(args.workspaceRoot, wsExpected))
        endStat()
        // The walk ran and proved the tree current (rows absent, or a
        // directory had moved — a benign touch): snapshot the directories
        // so the next hit skips the walk.
        if (skipRestore && !setKnown && dirPrefixes !== null) {
          await args.cache.recordOutputDirs?.(hash, node.projectDir, dirPrefixes)
        }
      }
    }
  }
  // An entry with NO rows (its declared outputs matched nothing at save
  // time, the warned case) is current exactly when the globs still match
  // nothing: then the empty artifact has nothing to put back and the read
  // of the tar is spared. A stray under the glob still falls through to
  // the clean, as strict ownership requires (item 589).
  if (anyOutputs && !skipRestore) {
    const expected = hit.outputRows ?? args.cache.loadOutputFilesBatch([hash]).get(hash) ?? []
    if (expected.length === 0) {
      const endGlob = span('output glob')
      const actual = await resolveOutputs({
        projectDir: node.projectDir,
        outputs,
        nestedProjectDirs: args.nestedProjectDirs,
      })
      const actualWs = await resolveWorkspaceOutputs({
        workspaceRoot: args.workspaceRoot,
        outputs: wsOutputs,
      })
      endGlob()
      skipRestore = actual.length === 0 && actualWs.length === 0
    }
  }
  if (!skipRestore) {
    let cleanedRels: string[] = []
    let cleanedWsRels: string[] = []
    if (additive) {
      cleanedRels = hit.outputFiles.filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX))
      await cleanOutputPaths({ projectDir: node.projectDir, rels: cleanedRels })
      cleanedWsRels = hit.outputFiles
        .filter((p) => p.startsWith(WORKSPACE_OUTPUT_PREFIX))
        .map((p) => p.slice(WORKSPACE_OUTPUT_PREFIX.length))
      await cleanOutputPaths({ projectDir: args.workspaceRoot, rels: cleanedWsRels })
    } else {
      if (outputs.length > 0) cleanedRels = await cleanOutputs(cleanArgs)
      if (wsOutputs.length > 0) cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
    }
    await args.cache.restoreOutputs(hash, node.projectDir, args.workspaceRoot)
    // The tree now holds this entry's bytes: stamp them for the next hit
    // (item 886).
    args.cache.recordOutputStamps?.(hash, node.projectDir, args.workspaceRoot)
    // The directory snapshot behind the NEXT hit's skip-restore, taken at
    // run end from the run's list (as the miss path does, see
    // miss-save.ts): the restore renamed into these directories
    // microseconds ago, inside the snapshot's racy window, so a snapshot
    // taken here was refused and the first warm run after every restore
    // walked its output trees — 41 of payload's 45 tasks, 14,430 files,
    // ~75 ms of the no-op's CPU (2026-09-11). A caller with no list gets
    // no snapshot (item 637: recording here was that same refusal).
    if (dirPrefixes !== null && args.outputDirSnapshots !== undefined) {
      args.outputDirSnapshots.push({ hash, projectDir: node.projectDir, prefixes: dirPrefixes })
    }
    // Restored outputs changed the project's tree — but on this
    // path we know the EXACT changed paths (wiped declared
    // outputs + the artifact's files). Record them instead of
    // dropping the snapshot; downstream same-project tasks only
    // re-spawn git when their input globs can actually see one of
    // these paths. The cache-miss save path keeps the
    // unconditional drop (an executed task may write undeclared
    // files only git can see).
    if (outputs.length > 0) {
      args.gitFilesCache?.markOutputsChanged(node.projectDir, [
        ...cleanedRels,
        ...hit.outputFiles.filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX)),
      ])
    }
    if (wsOutputs.length > 0) {
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, [
        ...cleanedWsRels,
        ...hit.outputFiles
          .filter((p) => p.startsWith(WORKSPACE_OUTPUT_PREFIX))
          .map((p) => p.slice(WORKSPACE_OUTPUT_PREFIX.length)),
      ])
    }
  }
  if (hit.stdout) log.taskStdout(node, hit.stdout)
  const status =
    hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
  // `restored` distinguishes "we just wrote files to disk" from
  // "disk already matched the cached snapshot". Drives the
  // "up-to-date" vs "local-cache" / "remote-cache" label in the
  // framed block. Only meaningful when at least one output was
  // declared — no-outputs tasks never materialize anything, so
  // they're vacuously up-to-date.
  const restored = !skipRestore && anyOutputs
  return {
    node,
    status,
    exitCode: hit.exitCode,
    // What THIS run spent: probe + restore. NOT the stored exec time — see
    // `storedDurationMs`, which is what the hit skipped.
    durationMs: Math.round(performance.now() - cacheOpStart),
    storedDurationMs: hit.durationMs,
    ...(hit.cpuMs !== undefined ? { storedCpuMs: hit.cpuMs } : {}),
    ...(hit.peakRssBytes !== undefined ? { storedPeakRssBytes: hit.peakRssBytes } : {}),
    hash,
    restored,
    wallclockStartNs: taskStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}
