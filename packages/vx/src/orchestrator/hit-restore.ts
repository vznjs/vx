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
  committedFiles,
  OUTPUT_DIRS_OVER_CAP,
  outputWalkTakes,
  resolveOutputTree,
  resolveWorkspaceOutputTree,
  sweepRestoreTemps,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import type { TaskOutcome } from '../graph/index.js'
import {
  asTrees,
  relPosix,
  secretMask,
  span,
  splitNegations,
  taskGlob,
  outputDirPrefixes,
} from '../util/index.js'
import type { ExecuteArgs } from './execute-task.js'
import { entryHolds } from './miss-save.js'
import { decodeOutputLog } from './output-log.js'

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
 * same-project tasks needn't re-spawn git, replay stored output, and
 * build the cache-hit `TaskOutcome`. Extracted from `executeCachedTask`
 * so the local short-circuit can restore a stable-key hit ahead of the
 * schedule using the IDENTICAL logic — there is one restore path, not
 * two that could drift.
 */
export async function restoreHit(given: RestoreHitArgs): Promise<TaskOutcome> {
  const { args, hash } = given
  const { node } = args
  const cacheCfg: CacheConfig | undefined = node.config.cache
  const outputs = cacheCfg?.outputs.files ?? []
  const wsOutputs = cacheCfg?.outputs.workspaceFiles ?? []
  const anyOutputs = outputs.length > 0 || wsOutputs.length > 0
  // A layer that handed no rows: one SELECT, read by both paths below.
  const restore =
    anyOutputs && given.hit.outputRows === undefined
      ? {
          ...given,
          hit: {
            ...given.hit,
            outputRows: args.cache.loadOutputFilesBatch([hash]).get(hash) ?? [],
          },
        }
      : given
  const { hit } = restore
  const now = currentHit(restore)
  if (now !== undefined) return now()
  // The directories the positive globs cover whole. A `!` entry inside one
  // leaves the snapshot sound: a file added or removed there still bumps a
  // recorded directory, and the walk that follows applies the `!` (A-46).
  // Asked only of a task that declares outputs: most hits declare none,
  // and a warm run of 1,000 such hits paid this set-up for each.
  const dirPrefixes = anyOutputs ? dirPrefixesOf(outputs) : null
  // The two sides of an overlapping pair (item 588). An ADDITIVE task owns
  // only its recorded rows: its glob also selects the upstream's files it
  // adds beside, so "no strays" is not a claim it can make, and its clean
  // takes the rows, never the glob. The UPSTREAM ignores what its
  // dependants declare they add when it judges its own tree current — an
  // addition below is not a stray — while its glob clean still takes them:
  // the dependant restores or runs after it, by the edge.
  const additive = (node.addsToOutputsOf?.length ?? 0) > 0
  const addedGlobs =
    anyOutputs && node.outputsAddedToBy !== undefined
      ? node.outputsAddedToBy.flatMap((g) => asTrees([g])).map((g) => taskGlob(g))
      : []
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
  // output replays from the row (`hit.stdout`), and its artifact holds
  // only logs. Extracting it anyway cost an `exists` + a tar read per hit
  // — 1.7 ms each on a four-task real repo whose `link` and `element`
  // tasks declare `outputs: []` (2026-09-10, `VX_DEBUG_TIMING`).
  let skipRestore = !anyOutputs
  // The walk that found the tree stale, handed to the clean when nothing
  // was awaited between them: the clean's own walk would only repeat it
  // (X-161).
  let walked: { proj: Tree; ws: Tree } | undefined
  if (anyOutputs) {
    const expected = hit.outputRows ?? []
    if (expected.length > 0) {
      // Two namespaces in the rows: bare rels are project outputs,
      // `workspace-outputs/<rel>` rows anchor at the workspace root.
      const projExpected = expected.filter((e) => !e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
      const wsExpected = expected
        .filter((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
        .map((e) => ({ ...e, path: e.path.slice(WORKSPACE_OUTPUT_PREFIX.length) }))
      const endGlob = span('output glob')
      const projTree = await resolveOutputTree({
        projectDir: node.projectDir,
        outputs,
        nestedProjectDirs: args.nestedProjectDirs,
      })
      const wsTree = await resolveWorkspaceOutputTree({
        workspaceRoot: args.workspaceRoot,
        outputs: wsOutputs,
      })
      endGlob()
      const actualAbs = projTree.files
      const actualWsAbs = wsTree.files
      // An empty directory is an entry row (`dist/empty/`): one the entry
      // does not hold is a stray, as a file is. A directory row with a row
      // under it is one kept for its mode (`DIR_MODE`), and the walk lists
      // no such directory: only the files and empty directories it holds.
      const setsMatch = (
        actual: readonly string[],
        exp: ReadonlyArray<{ path: string }>,
      ): boolean => {
        const held = new Set<string>()
        for (const { path: p } of exp) {
          for (let i = p.lastIndexOf('/', p.length - 2); i > 0; i = p.lastIndexOf('/', i - 1))
            held.add(p.slice(0, i + 1))
        }
        const expSet = new Set(
          exp.map((e) => e.path).filter((p) => !p.endsWith('/') || !held.has(p)),
        )
        return actual.length === expSet.size && actual.every((r) => expSet.has(r))
      }
      const dirRels = (root: string, dirs: readonly string[]): string[] =>
        dirs.map((d) => `${relPosix(root, d)}/`)
      // A stray a dependant's glob could have added is not a stray; a path
      // this entry recorded is never dropped, even where that glob covers
      // the whole tree (strapi's shape: both on `dist`).
      const expectedRels = new Set(projExpected.map((e) => e.path))
      const expectedWsRels = new Set(wsExpected.map((e) => e.path))
      const actualRels = actualAbs
        .map((p) => relPosix(node.projectDir, p))
        .filter((rel) => expectedRels.has(rel) || !isAddition(rel))
      const actualWsRels = actualWsAbs
        .map((p) => relPosix(args.workspaceRoot, p))
        .filter((rel) => expectedWsRels.has(rel) || !isAddition(rel))
      const actualDirRels = dirRels(node.projectDir, projTree.emptyDirs).filter(
        (rel) => expectedRels.has(rel) || !isAddition(rel.slice(0, -1)),
      )
      const actualWsDirRels = dirRels(args.workspaceRoot, wsTree.emptyDirs).filter(
        (rel) => expectedWsRels.has(rel) || !isAddition(rel.slice(0, -1)),
      )
      const rowsPresent = (
        actual: readonly string[],
        exp: ReadonlyArray<{ path: string }>,
      ): boolean => {
        const have = new Set(actual)
        return exp.every((e) => e.path.endsWith('/') || have.has(e.path))
      }
      const treeMatches = additive
        ? rowsPresent(actualRels, projExpected) && rowsPresent(actualWsRels, wsExpected)
        : setsMatch([...actualRels, ...actualDirRels], projExpected) &&
          setsMatch([...actualWsRels, ...actualWsDirRels], wsExpected)
      if (!treeMatches) walked = { proj: projTree, ws: wsTree }
      if (treeMatches) {
        const endStat = span('output stat')
        skipRestore =
          args.cache.isOutputsCurrent(node.projectDir, projExpected) &&
          args.cache.isOutputsCurrent(args.workspaceRoot, wsExpected)
        endStat()
        // The walk ran and proved the tree current (rows absent, or a
        // directory had moved — a benign touch): snapshot the directories
        // so the next hit skips the walk.
        if (
          skipRestore &&
          dirPrefixes !== null &&
          hit.outputDirRows?.some((r) => r.mtimeMs === OUTPUT_DIRS_OVER_CAP) !== true
        ) {
          // Held to the rows like the run-end snapshot (item 1087): a stray
          // written since the walk listed its directory, more than a racy
          // window before this, is not the entry's.
          const holds = entryHolds(
            node,
            outputWalkTakes(node.projectDir, outputs, args.nestedProjectDirs),
          )
          await args.cache.recordOutputDirs?.(hash, node.projectDir, dirPrefixes, (files) =>
            holds(files, expected),
          )
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
    const expected = hit.outputRows ?? []
    if (expected.length === 0) {
      const endGlob = span('output glob')
      const actual = await resolveOutputTree({
        projectDir: node.projectDir,
        outputs,
        nestedProjectDirs: args.nestedProjectDirs,
      })
      const actualWs = await resolveWorkspaceOutputTree({
        workspaceRoot: args.workspaceRoot,
        outputs: wsOutputs,
      })
      endGlob()
      skipRestore =
        actual.files.length + actual.emptyDirs.length + actualWs.files.length === 0 &&
        actualWs.emptyDirs.length === 0
      walked = { proj: actual, ws: actualWs }
    }
  }
  if (!skipRestore) {
    const cleanArgs = {
      projectDir: node.projectDir,
      outputs,
      nestedProjectDirs: args.nestedProjectDirs,
      committed: committedFiles(args.gitFilesCache, node.projectDir),
    }
    const wsCleanArgs = {
      workspaceRoot: args.workspaceRoot,
      outputs: wsOutputs,
      committed: committedFiles(args.gitFilesCache, args.workspaceRoot),
    }
    const heldRels = hit.outputFiles.filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX))
    const heldWsRels = hit.outputFiles
      .filter((p) => p.startsWith(WORKSPACE_OUTPUT_PREFIX))
      .map((p) => p.slice(WORKSPACE_OUTPUT_PREFIX.length))
    // In place, never clean-then-restore: each file is renamed over the one
    // it replaces, so a reader of the tree never finds a declared output
    // missing, and a restore that fails before its renames (a full disk,
    // a damaged entry) leaves the outputs it found as they were. Only what blocks a rename
    // goes first; what the entry does not hold goes after. The clean used
    // to run first: a reader polling a 64 MB output while ten hits restored
    // met ENOENT on 153,336 of 204,411 reads (2026-10-16). An ADDITIVE task
    // owns only its rows (item 588), and the restore rewrites exactly those.
    let foundRels: string[] = []
    let foundWsRels: string[] = []
    let staleRels: string[] = []
    let staleWsRels: string[] = []
    let staleDirs: string[] = []
    let staleWsDirs: string[] = []
    if (!additive) {
      sweepRestoreTemps(node.projectDir, outputs, cleanArgs.committed)
      sweepRestoreTemps(args.workspaceRoot, wsOutputs, wsCleanArgs.committed)
      if (outputs.length > 0) {
        const tree = walked?.proj ?? (await resolveOutputTree(cleanArgs))
        foundRels = tree.files.map((f) => relPosix(node.projectDir, f))
        const blocking = inTheWay(foundRels, heldRels)
        staleRels = notHeld(foundRels, heldRels).filter((f) => !blocking.has(f))
        const dirs = splitDirs(node.projectDir, tree.emptyDirs, heldRels)
        staleDirs = dirs.stale
        if (blocking.size > 0 || dirs.blocking.length > 0) {
          await cleanOutputPaths({
            projectDir: node.projectDir,
            rels: [...blocking],
            outputs,
            committed: cleanArgs.committed,
            emptyDirs: dirs.blocking,
          })
        }
      }
      if (wsOutputs.length > 0) {
        const tree = walked?.ws ?? (await resolveWorkspaceOutputTree(wsCleanArgs))
        foundWsRels = tree.files.map((f) => relPosix(args.workspaceRoot, f))
        const blocking = inTheWay(foundWsRels, heldWsRels)
        staleWsRels = notHeld(foundWsRels, heldWsRels).filter((f) => !blocking.has(f))
        const dirs = splitDirs(args.workspaceRoot, tree.emptyDirs, heldWsRels)
        staleWsDirs = dirs.stale
        if (blocking.size > 0 || dirs.blocking.length > 0) {
          await cleanOutputPaths({
            projectDir: args.workspaceRoot,
            rels: [...blocking],
            outputs: wsOutputs,
            committed: wsCleanArgs.committed,
            emptyDirs: dirs.blocking,
          })
        }
      }
    }
    await args.cache.restoreOutputs(hash, node.projectDir, args.workspaceRoot, {
      files: outputs,
      workspaceFiles: wsOutputs,
    })
    if (staleRels.length > 0 || staleDirs.length > 0) {
      await cleanOutputPaths({
        projectDir: node.projectDir,
        rels: staleRels,
        emptyDirs: staleDirs,
        outputs,
        committed: cleanArgs.committed,
        // A stale file in an output directory the entry holds empty takes
        // only itself: the directory stays, as the miss left it.
        keep: new Set(
          heldRels
            .filter((r) => r.endsWith('/'))
            .map((r) => path.join(node.projectDir, r.slice(0, -1))),
        ),
      })
    }
    if (staleWsRels.length > 0 || staleWsDirs.length > 0) {
      await cleanOutputPaths({
        projectDir: args.workspaceRoot,
        rels: staleWsRels,
        emptyDirs: staleWsDirs,
        outputs: wsOutputs,
        committed: wsCleanArgs.committed,
        keep: new Set(
          heldWsRels
            .filter((r) => r.endsWith('/'))
            .map((r) => path.join(args.workspaceRoot, r.slice(0, -1))),
        ),
      })
    }
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
      args.outputDirSnapshots.push({
        hash,
        projectDir: node.projectDir,
        prefixes: dirPrefixes,
        holds: entryHolds(node, outputWalkTakes(node.projectDir, outputs, args.nestedProjectDirs)),
      })
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
      args.gitFilesCache?.markOutputsChanged(node.projectDir, [...foundRels, ...heldRels])
    }
    if (wsOutputs.length > 0) {
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, [
        ...foundWsRels,
        ...heldWsRels,
      ])
    }
  }
  return hitOutcome(restore, !skipRestore && anyOutputs)
}

/**
 * The hit's outcome now, when its tree is provably current without a walk
 * or an await: it declares no outputs, or every directory the entry
 * recorded and every file it holds are as the entry left them (the
 * directory snapshot proves the set, the stamps the bytes). Undefined
 * sends it down `restoreHit`'s full path. Nothing happens until the thunk
 * runs, which replays the stored output: the scheduler starts a hit it
 * settles in place first, so its output follows its start.
 */
export function currentHit(restore: RestoreHitArgs): (() => TaskOutcome) | undefined {
  const { args, hash, hit } = restore
  const { node } = args
  const outputs = node.config.cache?.outputs.files ?? []
  if ((node.config.cache?.outputs.workspaceFiles?.length ?? 0) > 0) return undefined
  if (outputs.length > 0) {
    const dirPrefixes = dirPrefixesOf(outputs)
    if (dirPrefixes === null || args.cache.outputDirsCurrent === undefined) return undefined
    const expected = hit.outputRows ?? args.cache.loadOutputFilesBatch([hash]).get(hash) ?? []
    if (expected.length === 0) return undefined
    // Loaded with the entry (batched by getMany, or with the lazy get).
    const dirRows = hit.outputDirRows ?? []
    // Rows are recorded for these same prefixes under this same key (the
    // outputs are folded into it), so this cannot fail today (item 638).
    // Kept: a row set that shrank would otherwise vouch for a tree it never
    // saw, and the failure it would let through is a skipped restore.
    if (!dirPrefixes.every((pre) => dirRows.some((r) => r.path === pre))) return undefined
    if (!args.cache.outputDirsCurrent(node.projectDir, dirRows)) return undefined
    // No workspace output is declared, so every row is the project's.
    if (expected.some((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))) return undefined
    if (!args.cache.isOutputsCurrent(node.projectDir, expected)) return undefined
  }
  return () => hitOutcome(restore, false)
}

/** Replay the stored output and build the hit's outcome. */
function hitOutcome(restore: RestoreHitArgs, restored: boolean): TaskOutcome {
  const { args, hash, hit, cacheOpStart, taskStartNs } = restore
  const { node, log } = args
  if (hit.stdout) {
    // An entry saved before masking, or by another machine, can hold a
    // secret-named variable's value (L-11). Asked only of a hit that prints.
    const secrets = secretMask(
      [process.env, node.config.exec?.env?.define],
      node.config.exec?.env?.secret,
    )
    // The stored log holds both streams in the order the run printed them.
    for (const c of decodeOutputLog(hit.stdout)) {
      const text = secrets === null ? c.text : secrets.mask(c.text)
      if (c.err) log.taskStderr(node, text)
      else log.taskStdout(node, text)
    }
  }
  const status =
    hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
  // `restored` distinguishes "we just wrote files to disk" from
  // "disk already matched the cached snapshot". Drives the
  // "up-to-date" vs "local-cache" / "remote-cache" label in the
  // framed block. A hit the remote answered is never up to date: up to
  // date is fresh here, and a remote hit waited on the network and
  // downloaded its entry, outputs or none (2026-10-24: "Up to date is
  // a fresh. It should not require any cache").
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
    ...(hit.sizeBytes !== undefined ? { artifactBytes: hit.sizeBytes } : {}),
    ...(hit.fetchMs !== undefined ? { fetchMs: hit.fetchMs } : {}),
    hash,
    restored: restored || hit.source === 'remote',
    wallclockStartNs: taskStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}

/**
 * The whole-subtree directories of a task's output globs, memoised by the
 * list: a function of the declared globs alone, and a workspace declares a
 * handful of output lists over thousands of tasks (~5 ms of a 1,000-hit
 * warm run, unmemoised). Callers only read the result.
 */
function dirPrefixesOf(outputs: readonly string[]): readonly string[] | null {
  const key = JSON.stringify(outputs)
  let prefixes = prefixMemo.get(key)
  if (prefixes === undefined) {
    prefixes = outputDirPrefixes(splitNegations(outputs).positive)
    prefixMemo.set(key, prefixes)
  }
  return prefixes
}

const prefixMemo = new Map<string, readonly string[] | null>()

/**
 * On a case-insensitive volume (macOS's default) a rename onto `out.txt`
 * replaces `Out.txt`: the two are one file, and removing the found name
 * after the restore would remove the restored one.
 */
const fold: (rel: string) => string =
  process.platform === 'darwin' ? (rel) => rel.normalize('NFC').toLowerCase() : (rel) => rel

/**
 * The found outputs a rename cannot replace: a file where the entry needs a
 * directory (`dist/out` for `dist/out/a.js`) and a file under a path the
 * entry holds as a file (`dist/out/a.js` for `dist/out`), whose directory
 * the prune then takes.
 */
function inTheWay(found: readonly string[], held: readonly string[]): Set<string> {
  if (found.length === 0 || held.length === 0) return new Set()
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const h of held) {
    const key = fold(h)
    files.add(key)
    for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) dirs.add(key.slice(0, i))
  }
  const out = new Set<string>()
  for (const f of found) {
    const key = fold(f)
    if (dirs.has(key)) out.add(f)
    for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) {
      if (files.has(key.slice(0, i))) out.add(f)
    }
  }
  return out
}

/** The found outputs the entry does not hold: the stale ones, once it has restored. */
type Tree = { files: string[]; emptyDirs: string[] }

/**
 * The empty directories found under the outputs (absolute) that the entry
 * does not hold, as rels: one where it holds a file blocks that file's
 * rename and goes first, the rest go after the restore, as a miss's clean
 * takes them.
 */
function splitDirs(
  root: string,
  emptyDirs: readonly string[],
  held: readonly string[],
): { blocking: string[]; stale: string[] } {
  const heldKeys = new Set(held.map(fold))
  const blocking: string[] = []
  const stale: string[] = []
  for (const d of emptyDirs) {
    const rel = relPosix(root, d)
    if (heldKeys.has(fold(`${rel}/`))) continue
    if (heldKeys.has(fold(rel))) blocking.push(rel)
    else stale.push(rel)
  }
  return { blocking, stale }
}

function notHeld(found: readonly string[], held: readonly string[]): string[] {
  const keep = new Set(held.map(fold))
  return found.filter((f) => !keep.has(fold(f)))
}
