// Task entries by key for an executor that runs a task on another machine
// (`ExecutorContext.artifacts`, `CommandContext.artifacts`): the machine
// that ran it saves its outputs and output under the key the order named,
// and the one that needs them restores them, through the workspace's own
// cache (design packages/vx/docs/design/dte-2026-10.md, "Files").

import { type CacheLayer, resolveOutputTree, resolveWorkspaceOutputs } from '../cache/index.js'
import { secretMask } from '../util/index.js'
import { decodeOutputLog, encodeOutputLog } from './output-log.js'

/** The task a `TaskArtifacts` call names: where its outputs are and what ran. */
export interface ArtifactTask {
  /** `project#task`. */
  readonly id: string
  /** Absolute. */
  readonly projectDir: string
  readonly command: string
  /** Its `cache.outputs`: project-relative `files`, root-relative `workspaceFiles`. */
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
  /** The projects inside `projectDir` (absolute), whose files are not its outputs. */
  readonly nestedProjectDirs?: readonly string[]
}

/** What a task's run left besides its files: its output, and its time and usage. */
export interface ArtifactRun {
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly cpuMs?: number
  readonly peakRssBytes?: number
  /** Its environment: a secret value in it is masked out of the stored output. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface TaskArtifacts {
  /**
   * Keeps the files `task`'s outputs match, and its output, as entry
   * `key`: here, and on each remote the workspace writes. Resolves once
   * every upload has settled; a remote that fails degrades as a run's
   * upload does.
   */
  save(key: string, task: ArtifactTask, run: ArtifactRun): Promise<void>
  /**
   * Lays entry `key`'s files into the workspace, from the local store or
   * else the first remote holding it, and resolves its output; null when
   * none holds it. A key restored here and then saved is not uploaded
   * again.
   */
  restore(key: string, task: ArtifactTask): Promise<{ stdout: string; stderr: string } | null>
}

export function taskArtifacts(cache: CacheLayer, workspaceRoot: string): TaskArtifacts {
  return {
    async save(key, task, run) {
      const [tree, wsFiles] = await Promise.all([
        resolveOutputTree({
          projectDir: task.projectDir,
          outputs: task.outputs.files,
          nestedProjectDirs: [...(task.nestedProjectDirs ?? [])],
        }),
        resolveWorkspaceOutputs({ workspaceRoot, outputs: task.outputs.workspaceFiles }),
      ])
      const mask = secretMask([process.env, run.env ?? {}])
      const log = encodeOutputLog([
        { text: run.stdout, err: false },
        { text: run.stderr, err: true },
      ])
      await cache.save({
        hash: key,
        projectDir: task.projectDir,
        outputFiles: tree.files,
        ...(tree.emptyDirs.length > 0 ? { outputDirs: tree.emptyDirs } : {}),
        workspaceRoot,
        ...(wsFiles.length > 0 ? { workspaceOutputFiles: wsFiles } : {}),
        entry: {
          taskId: task.id,
          command: mask?.mask(task.command) ?? task.command,
          durationMs: run.durationMs,
          stdout: mask?.mask(log) ?? log,
          ...(run.cpuMs !== undefined ? { cpuMs: run.cpuMs } : {}),
          ...(run.peakRssBytes !== undefined ? { peakRssBytes: run.peakRssBytes } : {}),
        },
      })
      await cache.drainUploads?.()
    },

    async restore(key, task) {
      const entry = await (cache.getSaved ? cache.getSaved(key) : cache.get(key))
      if (entry === null) return null
      await cache.restoreOutputs(key, task.projectDir, workspaceRoot, task.outputs)
      let stdout = ''
      let stderr = ''
      for (const c of decodeOutputLog(entry.stdout)) {
        if (c.err) stderr += c.text
        else stdout += c.text
      }
      return { stdout, stderr }
    },
  }
}
