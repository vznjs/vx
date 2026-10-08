// What a MISS leaves behind once the command exited 0 and the task will
// save: the declared outputs resolved, the artifact and its rows saved in
// one transaction, the whole-subtree output prefixes recorded for the
// next hit's skip-restore, and the exact written paths marked against the
// git snapshot so a same-project consumer re-spawns git only when its
// globs can see them. Stale-hit-critical: a line moved here changes what
// a later run replays. Moved out of execute-task.ts 2026-09-09 as pure
// code motion.

import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  type CacheLayer,
  type GitFilesCache,
  resolveOutputs,
  resolveWorkspaceOutputs,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'
import {
  asTrees,
  relPosix,
  span,
  staticPrefix,
  taskGlob,
  wholeSubtreePrefixes,
} from '../util/index.js'
import type { Logger } from './logger.js'
import type { TaskInputComponent } from './task-hash.js'

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
): (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean {
  return (files, rows) => {
    const expected = new Set(
      rows.map((r) => r.path).filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX)),
    )
    const seen = new Set(files)
    if ((node.addsToOutputsOf?.length ?? 0) > 0) return [...expected].every((p) => seen.has(p))
    const added = (node.outputsAddedToBy ?? []).flatMap((g) => asTrees([g])).map(taskGlob)
    const kept = files.filter((f) => expected.has(f) || !added.some((g) => g.match(f)))
    return kept.length === expected.size && kept.every((f) => expected.has(f))
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
  /** Declared `cache.outputs.files` / `.workspaceFiles`. */
  outputs: readonly string[]
  wsOutputs: readonly string[]
  /**
   * An ADDITIVE task's own set (item 588): the files its run added or
   * changed under its declared outputs, resolved by execute-task against
   * the stamp it took before the run. Replaces the glob walk below, which
   * would also take the upstream's files the task adds beside.
   */
  ownOutputFiles?: string[] | undefined
  /** `ownOutputFiles` for `cache.outputs.workspaceFiles` (A-43). */
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
  deferSave?: ((save: () => Promise<void>) => Promise<void>) | undefined
  /** Time the save and size its artifact, for a telemetry sink: one stat. */
  measure?: boolean | undefined
}

/** What a measured save cost, on the outcome once it lands. */
export interface SaveFacts {
  saveMs?: number
  artifactBytes?: number
}

/**
 * `landed` settles when the entry is in the cache — at once without a lane —
 * with what it cost when `measure` asked.
 */
export async function saveMiss(a: SaveMissArgs): Promise<{ landed: Promise<SaveFacts> }> {
  const { node, cache, log } = a
  const endResolve = span('miss: resolve outputs')
  const outputFiles =
    a.ownOutputFiles ??
    (await resolveOutputs({
      projectDir: node.projectDir,
      outputs: a.outputs,
      nestedProjectDirs: a.nestedProjectDirs,
    }))
  const wsOutputFiles =
    a.ownWsOutputFiles ??
    (await resolveWorkspaceOutputs({
      workspaceRoot: a.workspaceRoot,
      outputs: a.wsOutputs,
    }))
  endResolve()
  // The mirror of the input warning: declared outputs that resolve to
  // nothing save an empty artifact, and the next hit "restores" it —
  // the build that ran nowhere looks like a build that ran. `files: []`
  // is a deliberate cached no-op and says nothing; a glob that matched
  // nothing is a glob against the wrong directory.
  if (
    a.outputs.length + a.wsOutputs.length > 0 &&
    outputFiles.length + wsOutputFiles.length === 0
  ) {
    // One cause is common enough to name, because the task shows no other
    // symptom: a sandboxed task with no write grant. Its writes land in the
    // sandbox's own scratch and never reach disk, and whether the shell
    // even notices depends on the layout — in a single-package workspace
    // (project dir === workspace root) the write SUCCEEDS into that
    // scratch and the task exits 0, so this warning is the only thing that
    // says the build produced nothing (item 444). A declared
    // `cache.outputs` is not a write grant; `exec.sandbox.allow.write` is.
    const sandboxed = node.config.exec?.sandbox !== undefined
    const grantsWrite = (node.config.exec?.sandbox?.allow?.write?.length ?? 0) > 0
    // A `workspaceFiles` directory linked out of the workspace drops every
    // file (M-65); a project one is refused by the resolver (X-88).
    const linkedOut = outputDirLinkedOut(a.workspaceRoot, a.wsOutputs)
    log.status(
      `[vx] ${node.id}: cache.outputs matched no files (${[...a.outputs, ...a.wsOutputs].join(', ')}) — ` +
        `an empty artifact is saved; a later hit restores nothing` +
        (linkedOut !== undefined
          ? ` — ${linkedOut.dir} is a symlink to ${linkedOut.target}, outside ${linkedOut.base}, and vx keeps only outputs inside it: make ${linkedOut.dir} a directory`
          : sandboxed && !grantsWrite
            ? ` — the task is sandboxed and declares no exec.sandbox.allow.write, so its writes never reached disk`
            : ''),
    )
  }
  const facts: SaveFacts = {}
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
      ...(wsOutputFiles.length > 0
        ? { workspaceOutputFiles: wsOutputFiles, workspaceRoot: a.workspaceRoot }
        : {}),
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
    if (a.measure === true) {
      facts.saveMs = Math.round(performance.now() - saveStart)
      try {
        facts.artifactBytes = statSync(cache.outputsPath(a.hash)).size
      } catch {
        // No local artifact (local writes off): no size to say.
      }
    }
    // The files the task just wrote are the entry's bytes: stamp them,
    // so the next hit can tell them from another entry's with the same
    // size and mtime (item 886).
    cache.recordOutputStamps?.(a.hash, node.projectDir, a.workspaceRoot)
    // The directory snapshot behind the next hit's skip-restore, taken at
    // run end from the run's list: the task wrote these directories
    // milliseconds ago, inside the snapshot's racy window, so a snapshot
    // taken here was refused and the next hit walked every output tree —
    // 1,000 walks, 296 ms accumulated, on the first warm run after a cold
    // build of the 1,000-project bench (2026-09-10). A caller with no
    // list gets no snapshot: recording here was that same refusal (item
    // 637 deleted the fallback and nothing reddened), and the next hit
    // walks, as it did.
    const savedDirPrefixes = wholeSubtreePrefixes(a.outputs)
    if (savedDirPrefixes !== null && a.outputDirSnapshots !== undefined) {
      a.outputDirSnapshots.push({
        hash: a.hash,
        projectDir: node.projectDir,
        prefixes: savedDirPrefixes,
        holds: entryHolds(node),
      })
    }
  }
  markWritten(a, outputFiles, wsOutputFiles)
  // Off the slot when the run keeps a lane (the save lane bounds and
  // drains it); in the slot otherwise — an embedder without a lane gets
  // the entry before the outcome.
  if (a.deferSave !== undefined) return { landed: a.deferSave(save).then(() => facts) }
  await save()
  return { landed: Promise.resolve(facts) }
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
 * save's: resolved and marked the same way.
 */
export async function markUnsaved(a: UnsavedArgs): Promise<void> {
  const endResolve = span('miss: resolve outputs')
  const outputFiles = await resolveOutputs({
    projectDir: a.node.projectDir,
    outputs: a.outputs,
    nestedProjectDirs: a.nestedProjectDirs,
  })
  const wsOutputFiles = await resolveWorkspaceOutputs({
    workspaceRoot: a.workspaceRoot,
    outputs: a.wsOutputs,
  })
  endResolve()
  markWritten(a, outputFiles, wsOutputFiles)
}

/**
 * The task just wrote outputs to the project's tree. Record the exact
 * declared-output paths as changed (same as the cache-hit restore path)
 * instead of dropping the whole snapshot: a downstream same-project task
 * then re-spawns git ONLY when its input globs can actually see one of
 * these paths. On a 1000-package cold run this removes ~one synchronous
 * `git ls-files` spawn per project (the single largest cold-run cost —
 * 22% of CPU in profiling). Contract: outputs must be declared — an
 * executed task that writes files outside `cache.outputs.files` which a
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
  // The workspace-wide partition (when one exists) spans this project's
  // subtree, so it inherits the same "undeclared writes are only visible
  // to git" rule as the project drop above.
  if (outputFiles.length + wsOutputFiles.length > 0) {
    a.gitFilesCache?.invalidateWorkspacePartition()
  }
}

/**
 * The first `workspaceFiles` directory that is a symlink resolving outside
 * the workspace root: every file under it is dropped as outside, and the
 * empty-artifact warning blamed the glob (M-65).
 */
function outputDirLinkedOut(
  baseDir: string,
  outputs: readonly string[],
): { dir: string; target: string; base: string } | undefined {
  const realProject = realpathOrNull(baseDir) ?? baseDir
  // `dist` names the tree `dist/**`: the same reading the resolver gives.
  for (const pattern of asTrees(outputs.filter((o) => !o.startsWith('!')))) {
    const literal = staticPrefix(pattern)
      .split('/')
      .filter((p) => p !== '' && p !== '.')
    for (let i = 1; i <= literal.length; i++) {
      const dir = literal.slice(0, i).join('/')
      const abs = path.join(baseDir, dir)
      try {
        if (!lstatSync(abs).isSymbolicLink()) continue
      } catch {
        break
      }
      const target = realpathOrNull(abs)
      if (target !== null && target !== realProject && !target.startsWith(realProject + path.sep)) {
        return { dir, target, base: 'the workspace' }
      }
    }
  }
  return undefined
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}
