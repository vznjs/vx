// What a MISS leaves behind once the command exited 0 and the task will
// save: the declared outputs resolved, the artifact and its rows saved in
// one transaction, the whole-subtree output prefixes recorded for the
// next hit's skip-restore, and the exact written paths marked against the
// git snapshot so a same-project consumer re-spawns git only when its
// globs can see them. Stale-hit-critical: a line moved here changes what
// a later run replays. Moved out of execute-task.ts 2026-09-09 as pure
// code motion.

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  type CacheLayer,
  type GitFilesCache,
  resolveOutputTree,
  outputWalkTakes,
  resolveOutputs,
  resolveWorkspaceOutputs,
  resolveWorkspaceOutputTree,
  type TaskInputComponent,
} from '../cache/index.js'
import { WORKSPACE_OUTPUT_PREFIX } from '../memo/index.js'
import type { TaskNode, TaskOutcome } from '../graph/index.js'
import {
  anyTaskGlob,
  asTrees,
  isLiteralPattern,
  outputDirPrefixes,
  printable,
  relPosix,
  span,
  splitNegations,
  taskGlob,
} from '../util/index.js'
import { type Logger, warnOf } from '../report/index.js'
import { declareStateHint, stateLeft, type StateStamps } from './undeclared-state.js'

/** A snapshot request for `recordOutputDirs`, taken at run end. */
export interface OutputDirSnapshot {
  hash: string
  projectDir: string
  prefixes: readonly string[]
  /** Whether the files the run-end walk saw are the entry's rows (`recordOutputDirs`). */
  holds: (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean
}

/**
 * The `holds` of a run-end snapshot: the files under the prefixes are the
 * entry's project rows, by the rule the next hit's walk applies. An
 * additive task's rows need only be present (the upstream's files sit
 * beside them); an upstream's tree may also hold what a dependant's glob
 * adds. A stray a later task or another process wrote there before run
 * end refuses the snapshot, and the next hit walks and restores
 * (item 1087). The run reads every snapshot's rows in one batch.
 */
export function entryHolds(
  node: TaskNode,
  takes: (rel: string) => boolean,
): (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean {
  return (walked, rows) => {
    // A root-anchored glob's snapshot walks the whole project: only what
    // the glob takes is the entry's.
    const files = walked.filter(takes)
    const expected = new Set(
      rows
        .map((r) => r.path)
        .filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX) && !p.endsWith('/')),
    )
    const seen = new Set(files)
    if ((node.addsToOutputsOf?.length ?? 0) > 0) return [...expected].every((p) => seen.has(p))
    const added = (node.outputsAddedToBy ?? []).flatMap((g) => asTrees([g])).map(taskGlob)
    const kept = files.filter((f) => expected.has(f) || !added.some((g) => g.match(f)))
    return kept.length === expected.size && kept.every((f) => expected.has(f))
  }
}

/**
 * The run-end output-directory snapshots, taken once the directories are
 * old enough for the snapshot's racy window. Each walk is held to its
 * entry's rows (item 1087), read in one batch: read per snapshot, each read
 * also flushed the snapshots before it, one transaction apiece (+110 ms at
 * 1,000). A few walks at a time: each is an lstat + readdir per prefix; the
 * rows land together at close, in one transaction.
 */
export async function recordOutputDirSnapshots(
  cache: CacheLayer,
  snapshots: readonly OutputDirSnapshot[],
): Promise<void> {
  const rowsOf = new Map<string, ReadonlyArray<{ path: string }>>()
  for (let i = 0; i < snapshots.length; i += 900) {
    const batch = cache.memo.loadOutputFilesBatch(snapshots.slice(i, i + 900).map((s) => s.hash))
    for (const [hash, rows] of batch) rowsOf.set(hash, rows)
  }
  for (let i = 0; i < snapshots.length; i += 32) {
    await Promise.all(
      snapshots
        .slice(i, i + 32)
        .map((s) =>
          cache.memo.recordOutputDirs?.(s.hash, s.projectDir, s.prefixes, (files) =>
            s.holds(files, rowsOf.get(s.hash) ?? []),
          ),
        ),
    )
  }
}

export interface SaveMissArgs {
  node: TaskNode
  hash: string
  cache: CacheLayer
  log: Logger
  workspaceRoot: string
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache | undefined
  /** Declared `outputs.files` / `.workspaceFiles`. */
  outputs: readonly string[]
  wsOutputs: readonly string[]
  /**
   * An ADDITIVE task's own set (item 588): the files its run added or
   * changed under its declared outputs, resolved by execute-task against
   * the stamp it took before the run. Replaces the glob walk below, which
   * would also take the upstream's files the task adds beside.
   */
  ownOutputFiles?: string[] | undefined
  /** `ownOutputFiles` for `outputs.workspaceFiles` (A-43). */
  ownWsOutputFiles?: string[] | undefined
  /** The Tier-3 input fingerprint rows captured by the pre-exec describe. */
  captured: readonly TaskInputComponent[]
  command: string
  durationMs: number
  stdout: string
  /** The execution's usage, when the runner reported it — rides the artifact's sidecar. */
  cpuMs?: number | undefined
  peakRssBytes?: number | undefined
  /** When present, the directory snapshot is queued here instead of taken now. */
  outputDirSnapshots?: OutputDirSnapshot[] | undefined
  /**
   * When present, the cache save itself runs off the execution slot: the
   * outputs are resolved and the git snapshot marked here, in the slot
   * (a same-project downstream task reads both), and the pack + write +
   * index go to the run's save lane (save-lane.ts).
   */
  deferSave?: ((save: () => Promise<void>, taskId: string) => Promise<boolean>) | undefined
  /** Time the save and size its artifact, for a telemetry sink: one stat. */
  measure?: boolean | undefined
  /** The undeclared ignored files the miss stamped (`undeclared-state.ts`). */
  state?: StateStamps | undefined
}

/** What a measured save cost, on the outcome once it lands. */
export interface SaveFacts {
  saveMs?: number
  artifactBytes?: number
  /** The saved files' bytes, as a hit's `outputBytes` counts them: the row's `outputs`. */
  outputBytes?: number
  /** The entry landed: the outcome's `saved`, set only once it has. */
  saved?: true
}

/** The outcome a deferred save settles: what the save cost, folded in. */
export function withSaveFacts(o: TaskOutcome, f: SaveFacts): TaskOutcome {
  if (f.saveMs !== undefined) (o.timing ??= {}).saveMs = f.saveMs
  if (f.artifactBytes === undefined && f.outputBytes === undefined && f.saved === undefined)
    return o
  const cache = (o.cache ??= {})
  if (f.artifactBytes !== undefined) cache.artifactBytes = f.artifactBytes
  if (f.outputBytes !== undefined) cache.outputBytes = f.outputBytes
  if (f.saved !== undefined) cache.saved = f.saved
  return o
}

/**
 * `landed` settles when the entry is in the cache — at once without a lane —
 * with what it cost when `measure` asked.
 */
export async function saveMiss(a: SaveMissArgs): Promise<{ landed: Promise<SaveFacts> }> {
  const { node, cache, log } = a
  const endResolve = span('miss: resolve outputs')
  // An additive task owns only the files it wrote (item 588), no directory.
  const tree =
    a.ownOutputFiles !== undefined
      ? { files: a.ownOutputFiles, emptyDirs: [], special: [] }
      : await resolveOutputTree({
          projectDir: node.projectDir,
          outputs: a.outputs,
          nestedProjectDirs: a.nestedProjectDirs,
          inputs: {
            projectDir: node.projectDir,
            workspaceRoot: a.workspaceRoot,
            declared: node.config.inputs,
          },
          special: true,
        })
  const outputFiles = tree.files
  const wsTree =
    a.ownWsOutputFiles !== undefined
      ? { files: a.ownWsOutputFiles, emptyDirs: [], special: [] }
      : await resolveWorkspaceOutputTree({
          workspaceRoot: a.workspaceRoot,
          outputs: a.wsOutputs,
          inputs: {
            projectDir: node.projectDir,
            workspaceRoot: a.workspaceRoot,
            declared: node.config.inputs,
          },
          special: true,
        })
  const wsOutputFiles = wsTree.files
  endResolve()
  // A FIFO, socket or device holds no bytes to store (opening a FIFO waits
  // for a writer, nx#35228), so it stays out of the entry; said, because a
  // hit restores the tree without it.
  const special = [
    ...tree.special.map((p) => relPosix(node.projectDir, p)),
    ...wsTree.special.map((p) => relPosix(a.workspaceRoot, p)),
  ]
  if (special.length > 0) {
    warnOf(log)(
      `[vx] ${node.id}: ${special.join(', ')} ${special.length === 1 ? 'is' : 'are'} not a regular file or symlink ` +
        `(a FIFO, socket or device): vx does not cache ${special.length === 1 ? 'it' : 'them'}, so a hit restores the outputs without ${special.length === 1 ? 'it' : 'them'} ` +
        `— emit a file there, or take ${special.length === 1 ? 'it' : 'them'} back with a '!' entry`,
    )
  }
  // The mirror of the input warning: declared outputs that resolve to
  // nothing save an empty artifact, and the next hit "restores" it —
  // the build that ran nowhere looks like a build that ran. `files: []`
  // is a deliberate cached no-op and says nothing; a glob that matched
  // nothing is a glob against the wrong directory.
  const noFiles =
    a.outputs.length + a.wsOutputs.length > 0 && outputFiles.length + wsOutputFiles.length === 0
  // Empty directories are saved and a hit makes them.
  const empty = noFiles && tree.emptyDirs.length + wsTree.emptyDirs.length === 0
  const dead = empty
    ? []
    : deadOutputGlobs(
        a,
        node.projectDir,
        [...outputFiles, ...tree.emptyDirs],
        [...wsOutputFiles, ...wsTree.emptyDirs],
      )
  // Outputs that came out empty beside an undeclared ignored file: an
  // incremental tool's state said the cleaned outputs were built, and it
  // wrote nothing (`tsc -b` after vx deleted `dist/`, which the clean left).
  const left =
    (noFiles || dead.length > 0) && a.state !== undefined ? stateLeft(a.state, node.projectDir) : []
  if (left.length > 0) {
    warnOf(log)(
      `[vx] ${node.id}: outputs matched no files (${(noFiles ? [...a.outputs, ...a.wsOutputs] : dead).join(', ')}) ` +
        `while ${left.map(printable).join(', ')}, which git ignores and the task declares neither input nor output, ` +
        `survived the clean — the result stands, but is not saved: a tool that reads such a file back ` +
        `(an incremental build's state) may take the cleaned outputs as built` +
        declareStateHint(left),
    )
    markWritten(a, outputFiles, wsOutputFiles)
    return { landed: Promise.resolve({}) }
  }
  if (empty) {
    // One cause is common enough to name, because the task shows no other
    // symptom: a sandboxed task with no write grant. Its writes land in the
    // sandbox's own scratch and never reach disk, and whether the shell
    // even notices depends on the layout — in a single-package workspace
    // (project dir === workspace root) the write SUCCEEDS into that
    // scratch and the task exits 0, so this warning is the only thing that
    // says the build produced nothing (item 444). A declared
    // `outputs` is not a write grant; `exec.sandbox.allow.write` is.
    const sandboxed = node.config.exec?.sandbox !== undefined
    const grantsWrite = (node.config.exec?.sandbox?.allow?.write?.length ?? 0) > 0
    warnOf(log)(
      `[vx] ${node.id}: outputs matched no files (${[...a.outputs, ...a.wsOutputs].join(', ')}) — ` +
        `an empty artifact is saved; a later hit restores nothing` +
        (sandboxed && !grantsWrite
          ? ` — the task is sandboxed and declares no exec.sandbox.allow.write, so its writes never reached disk`
          : '') +
        bracketLiteralHint([
          ...a.outputs.map((g) => [node.projectDir, g] as const),
          ...a.wsOutputs.map((g) => [a.workspaceRoot, g] as const),
        ]),
    )
  } else {
    if (dead.length > 0) {
      const literal = [...a.outputs, ...a.wsOutputs].filter(
        (g) => !g.startsWith('!') && isLiteralPattern(g),
      )
      warnOf(log)(
        `[vx] ${node.id}: outputs matched no files (${dead.join(', ')}) — ` +
          `a later hit restores only the literal files (${literal.join(', ')})` +
          bracketLiteralHint([
            ...a.outputs.map((g) => [node.projectDir, g] as const),
            ...a.wsOutputs.map((g) => [a.workspaceRoot, g] as const),
          ]),
      )
    }
  }
  const facts: SaveFacts = {}
  let kept = false
  const save = async (): Promise<void> => {
    const saveStart = a.measure === true ? performance.now() : 0
    const endSave = span('miss: save')
    // Tier-3 input fingerprint: the digest rows captured by the pre-exec
    // describe above, persisted with the entry inside `cache.save`'s
    // transaction. Miss path only — the warm/hit path never reaches here.
    await cache.save({
      hash: a.hash,
      projectDir: node.projectDir,
      outputFiles,
      ...(tree.emptyDirs.length > 0 ? { outputDirs: tree.emptyDirs } : {}),
      // The root an output symlink's target must stay inside, outputs.workspaceFiles or not.
      workspaceRoot: a.workspaceRoot,
      ...(wsOutputFiles.length > 0 ? { workspaceOutputFiles: wsOutputFiles } : {}),
      ...(wsTree.emptyDirs.length > 0 ? { workspaceOutputDirs: wsTree.emptyDirs } : {}),
      inputComponents: a.captured.map((c) => ({ entryHash: a.hash, ...c })),
      // No `exitCode`: the save only runs under `effectiveExitCode === 0`, and
      // the contract no longer accepts one — so the invariant is enforced by
      // the type rather than by every call site remembering the gate.
      entry: {
        taskId: node.id,
        command: a.command,
        durationMs: a.durationMs,
        stdout: a.stdout,
        ...(a.cpuMs !== undefined ? { cpuMs: a.cpuMs } : {}),
        ...(a.peakRssBytes !== undefined ? { peakRssBytes: a.peakRssBytes } : {}),
      },
    })
    endSave()
    const bytes = cache.outputBytes?.(a.hash)
    if (bytes !== undefined) facts.outputBytes = bytes
    // A `--force` run that found the key stored kept that entry: the
    // footer's `↑` counts saves, and this was none.
    if (cache.kept?.(a.hash) === true) kept = true
    if (a.measure === true) {
      facts.saveMs = Math.round(performance.now() - saveStart)
      // No local artifact (local writes off): no size to say.
      const size =
        cache.artifactSize !== undefined
          ? cache.artifactSize(a.hash)
          : statSync(cache.outputsPath(a.hash), { throwIfNoEntry: false })?.size
      if (size !== undefined) facts.artifactBytes = size
    }
    // The files the task just wrote are the entry's bytes: stamp them,
    // so the next hit can tell them from another entry's with the same
    // size and mtime (item 886).
    cache.memo.recordOutputStamps?.(a.hash, node.projectDir, a.workspaceRoot)
    // The directory snapshot behind the next hit's skip-restore, taken at
    // run end from the run's list: the task wrote these directories
    // milliseconds ago, inside the snapshot's racy window, so a snapshot
    // taken here was refused and the next hit walked every output tree —
    // 1,000 walks, 296 ms accumulated, on the first warm run after a cold
    // build of the 1,000-project bench (2026-09-10). A caller with no
    // list gets no snapshot: recording here was that same refusal (item
    // 637 deleted the fallback and nothing reddened), and the next hit
    // walks, as it did.
    const savedDirPrefixes = outputDirPrefixes(splitNegations(a.outputs).positive)
    if (savedDirPrefixes !== null && a.outputDirSnapshots !== undefined) {
      a.outputDirSnapshots.push({
        hash: a.hash,
        projectDir: node.projectDir,
        prefixes: savedDirPrefixes,
        holds: entryHolds(node, outputWalkTakes(node.projectDir, a.outputs, a.nestedProjectDirs)),
      })
    }
  }
  markWritten(a, outputFiles, wsOutputFiles)
  // Off the slot when the run keeps a lane (the save lane bounds and
  // drains it); in the slot otherwise — an embedder without a lane gets
  // the entry before the outcome.
  if (a.deferSave !== undefined) {
    return {
      landed: a
        .deferSave(save, node.id)
        .then((stored) => (stored && !kept ? { ...facts, saved: true } : facts)),
    }
  }
  await save()
  return { landed: Promise.resolve(kept ? facts : { ...facts, saved: true }) }
}

/** What `markUnsaved` reads of a miss: where its declared outputs are. */
export type UnsavedArgs = Pick<
  SaveMissArgs,
  'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'gitFilesCache' | 'outputs' | 'wsOutputs'
>

/**
 * A miss that ran here and saves nothing (it failed, the policy writes
 * nothing, an upstream failed, its key no longer held) still wrote its
 * outputs, and a same-project reader after it must see them as it sees a
 * save's: resolved and marked the same way. Returns their bytes, the
 * row's `outputs`: blank, an unsaved miss read as one that wrote nothing.
 */
export async function markUnsaved(a: UnsavedArgs): Promise<number> {
  const { outputFiles, wsOutputFiles } = await resolveUnsaved(a)
  markWritten(a, outputFiles, wsOutputFiles)
  return sizeOf(a.node.projectDir, outputFiles) + sizeOf(a.workspaceRoot, wsOutputFiles)
}

/** An unsaved miss nothing reads after: only the bytes of its outputs, its row's `outputs`. */
export async function unsavedOutputBytes(
  a: Pick<UnsavedArgs, 'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'outputs' | 'wsOutputs'>,
): Promise<number> {
  const { outputFiles, wsOutputFiles } = await resolveUnsaved(a)
  return sizeOf(a.node.projectDir, outputFiles) + sizeOf(a.workspaceRoot, wsOutputFiles)
}

async function resolveUnsaved(
  a: Pick<UnsavedArgs, 'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'outputs' | 'wsOutputs'>,
): Promise<{ outputFiles: string[]; wsOutputFiles: string[] }> {
  const endResolve = span('miss: resolve outputs')
  const outputFiles = await resolveOutputs({
    projectDir: a.node.projectDir,
    outputs: a.outputs,
    nestedProjectDirs: a.nestedProjectDirs,
    inputs: {
      projectDir: a.node.projectDir,
      workspaceRoot: a.workspaceRoot,
      declared: a.node.config.inputs,
    },
  })
  const wsOutputFiles = await resolveWorkspaceOutputs({
    workspaceRoot: a.workspaceRoot,
    outputs: a.wsOutputs,
    inputs: {
      projectDir: a.node.projectDir,
      workspaceRoot: a.workspaceRoot,
      declared: a.node.config.inputs,
    },
  })
  endResolve()
  return { outputFiles, wsOutputFiles }
}

/** The bytes of `files` (absolute, or under `base`); one gone since it was listed counts none. */
function sizeOf(base: string, files: readonly string[]): number {
  let n = 0
  for (const f of files) n += statSync(path.resolve(base, f), { throwIfNoEntry: false })?.size ?? 0
  return n
}

/**
 * The task just wrote outputs to the project's tree. Record the exact
 * declared-output paths as changed (same as the cache-hit restore path)
 * instead of dropping the whole snapshot: a downstream same-project task
 * then re-spawns git ONLY when its input globs can actually see one of
 * these paths. On a 1000-package cold run this removes ~one synchronous
 * `git ls-files` spawn per project (the single largest cold-run cost —
 * 22% of CPU in profiling). Contract: outputs must be declared — an
 * executed task that writes files outside `outputs.files` which a
 * same-project downstream task reads is undeclared behavior (the restore
 * path already assumes it).
 */
function markWritten(
  a: Pick<SaveMissArgs, 'node' | 'workspaceRoot' | 'gitFilesCache'>,
  outputFiles: readonly string[],
  wsOutputFiles: readonly string[],
): void {
  const { projectDir } = a.node
  if (outputFiles.length > 0) {
    a.gitFilesCache?.markOutputsChanged(
      projectDir,
      outputFiles.map((p) => relPosix(projectDir, p)),
    )
  }
  // Declared workspace outputs may have landed inside OTHER projects' dirs
  // (no-boundary escape hatch) — mark the exact paths against every
  // partition that can see them.
  if (wsOutputFiles.length > 0) {
    a.gitFilesCache?.markWorkspaceOutputsChanged(
      a.workspaceRoot,
      wsOutputFiles.map((f) => relPosix(a.workspaceRoot, f)),
    )
  }
  // The workspace-wide partition spans this project's subtree and takes the
  // same marks (`markOutputsChanged` forwards them): it stands for a reader
  // whose globs take none of them, as the project's does. Dropped here, each
  // `workspaceFiles` task after a save listed the workspace again and was
  // remembered under a token the next run's enumeration never names, so the
  // first run after a build derived every such key again (vueuse: ten of
  // twelve, 2026-11-12).
}

/**
 * The wildcard output globs, when not one of them matched: the literal
 * files beside them did, so the artifact is not empty and a later hit
 * restores only those. turbo()/nx() add `tsconfig.tsbuildinfo` to an
 * incremental tsc task; `tsc --outDir out` then left `dist/**` empty under
 * a silent save. `deadSourceGlobs`' rule (execute-task.ts) for outputs: an
 * empty directory a glob matched counts, a hit makes it. Stops at the
 * first matched path.
 */
function deadOutputGlobs(
  a: Pick<SaveMissArgs, 'outputs' | 'wsOutputs' | 'workspaceRoot'>,
  projectDir: string,
  own: readonly string[],
  ws: readonly string[],
): string[] {
  const wild = (globs: readonly string[]): string[] =>
    globs.filter((g) => !g.startsWith('!') && !isLiteralPattern(g))
  const ownWild = wild(a.outputs)
  const wsWild = wild(a.wsOutputs)
  if (ownWild.length === 0 && wsWild.length === 0) return []
  const ownMatch = anyTaskGlob(ownWild)
  const wsMatch = anyTaskGlob(wsWild)
  for (const p of own) if (ownMatch(relPosix(projectDir, p))) return []
  for (const p of ws) if (wsMatch(relPosix(a.workspaceRoot, p))) return []
  // As the input rule: a link to a directory is listed by its own name,
  // which a glob reaching below it does not match.
  for (const p of [...own, ...ws]) if (linksToDir(p)) return []
  return [...ownWild, ...wsWild]
}

function linksToDir(abs: string): boolean {
  try {
    return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

/**
 * The clause a "matched no files" warning gains when a glob holds an
 * unescaped `[` and, read as a literal path, names something on disk:
 * `app/[slug]/page.tsx` is a character class (caching.md) that matches
 * no route, so the key stops following the file and an edit replays the
 * old output. Only on a warning's path; one stat per such glob, on
 * its literal prefix up to the first segment holding another glob token.
 */
export function bracketLiteralHint(
  globs: readonly (readonly [base: string, glob: string])[],
): string {
  let hint = ''
  for (const [base, glob] of globs) {
    if (glob.startsWith('!') || !/(^|[^\\])\[/.test(glob)) continue
    const segments: string[] = []
    for (const seg of glob.split('/')) {
      if (/(^|[^\\])[*?{}]/.test(seg)) break
      segments.push(seg)
    }
    const prefix = segments.join('/')
    if (!/(^|[^\\])\[/.test(prefix)) continue
    const literal = prefix.replace(/\\(.)/g, '$1')
    if (!existsSync(path.join(base, literal))) continue
    const escaped = glob.replace(/(^|[^\\])(?=[[\]])/g, '$1\\')
    hint += ` — [ starts a character class and ${literal} exists: write ${escaped} to name it`
  }
  return hint
}
