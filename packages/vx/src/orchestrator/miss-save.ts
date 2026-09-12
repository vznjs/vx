// What a MISS leaves behind once the command exited 0 and the task will
// save: the declared outputs resolved, the artifact and its rows saved in
// one transaction, the whole-subtree output prefixes recorded for the
// next hit's skip-restore, and the exact written paths marked against the
// git snapshot so a same-project consumer re-spawns git only when its
// globs can see them. Stale-hit-critical: a line moved here changes what
// a later run replays. Moved out of execute-task.ts 2026-09-09 as pure
// code motion.

import path from 'node:path'
import {
  type CacheLayer,
  type GitFilesCache,
  resolveOutputs,
  resolveWorkspaceOutputs,
} from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'
import { span, wholeSubtreePrefixes } from '../util/index.js'
import type { Logger } from './logger.js'
import type { TaskInputComponent } from './task-hash.js'

/** A snapshot request for `recordOutputDirs`, taken at run end. */
export interface OutputDirSnapshot {
  hash: string
  projectDir: string
  prefixes: readonly string[]
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
  outputs: string[]
  wsOutputs: string[]
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
}

/** `landed` settles when the entry is in the cache — at once without a lane. */
export async function saveMiss(a: SaveMissArgs): Promise<{ landed: Promise<void> }> {
  const { node, cache, log } = a
  const endResolve = span('miss: resolve outputs')
  const outputFiles = await resolveOutputs({
    projectDir: node.projectDir,
    outputs: a.outputs,
    nestedProjectDirs: a.nestedProjectDirs,
  })
  const wsOutputFiles = await resolveWorkspaceOutputs({
    workspaceRoot: a.workspaceRoot,
    outputs: a.wsOutputs,
  })
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
    log.status(
      `[vx] ${node.id}: cache.outputs matched no files (${[...a.outputs, ...a.wsOutputs].join(', ')}) — ` +
        `an empty artifact is saved; a later hit restores nothing`,
    )
  }
  const save = async (): Promise<void> => {
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
    // The directory snapshot behind the next hit's skip-restore. Taken at
    // run end when the run keeps a list: the task wrote these directories
    // milliseconds ago, inside the snapshot's racy window, so a snapshot
    // taken here was refused and the next hit walked every output tree —
    // 1,000 walks, 296 ms accumulated, on the first warm run after a cold
    // build of the 1,000-project bench (2026-09-10).
    const savedDirPrefixes = wholeSubtreePrefixes(a.outputs)
    if (savedDirPrefixes !== null) {
      if (a.outputDirSnapshots !== undefined) {
        a.outputDirSnapshots.push({
          hash: a.hash,
          projectDir: node.projectDir,
          prefixes: savedDirPrefixes,
        })
      } else {
        await cache.recordOutputDirs?.(a.hash, node.projectDir, savedDirPrefixes)
      }
    }
  }
  // This task just wrote outputs to the project's tree. Record the
  // exact declared-output paths as changed (same as the cache-hit
  // restore path) instead of dropping the whole snapshot: a downstream
  // same-project task then re-spawns git ONLY when its input globs can
  // actually see one of these paths. On a 1000-package cold run this
  // removes ~one synchronous `git ls-files` spawn per project (the
  // single largest cold-run cost — 22% of CPU in profiling). Contract:
  // outputs must be declared — an executed task that writes files
  // outside `cache.outputs.files` which a same-project downstream task
  // reads is undeclared behavior (the restore path already assumes it).
  if (outputFiles.length > 0) {
    a.gitFilesCache?.markOutputsChanged(
      node.projectDir,
      outputFiles.map((p) => path.relative(node.projectDir, p).split(path.sep).join('/')),
    )
  }
  // Declared workspace outputs may have landed inside OTHER
  // projects' dirs (no-boundary escape hatch) — mark the exact
  // paths against every partition that can see them.
  if (wsOutputFiles.length > 0) {
    a.gitFilesCache?.markWorkspaceOutputsChanged(
      a.workspaceRoot,
      wsOutputFiles.map((f) => path.relative(a.workspaceRoot, f).split(path.sep).join('/')),
    )
  }
  // The workspace-wide partition (when one exists) spans this
  // project's subtree, so it inherits the same "undeclared writes
  // are only visible to git" rule as the project drop above.
  if (outputFiles.length + wsOutputFiles.length > 0) {
    a.gitFilesCache?.invalidateWorkspacePartition()
  }
  // Off the slot when the run keeps a lane (the save lane bounds and
  // drains it); in the slot otherwise — an embedder without a lane gets
  // the entry before the outcome.
  if (a.deferSave !== undefined) return { landed: a.deferSave(save) }
  await save()
  return { landed: Promise.resolve() }
}
