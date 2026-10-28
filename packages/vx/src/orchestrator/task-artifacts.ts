// Task entries by key for an executor that runs a task on another machine
// (`ExecutorContext.artifacts`, `CommandContext.artifacts`): the machine
// that ran it saves its outputs and output under the key the order named,
// and the one that needs them restores them, through the workspace's own
// cache (design packages/vx/docs/design/dte-2026-10.md, "Files").

import {
  type CacheLayer,
  type ResolvedRemote,
  resolveOutputTree,
  resolveWorkspaceOutputs,
  sayRemoteFault,
} from '../cache/index.js'
import type { CapturedChunk } from '../exec/index.js'
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
  /**
   * Files under its outputs it found and left as they were (absolute): an
   * upstream's, which an additive task builds on, not its entry's.
   */
  readonly others?: ReadonlySet<string>
}

/** What a task's run left besides its files: its output, and its time and usage. */
export interface ArtifactRun {
  /** Both streams in the order they were written, as a `BoundedCapture` keeps them. */
  readonly output: readonly CapturedChunk[]
  readonly durationMs: number
  readonly cpuMs?: number
  readonly peakRssBytes?: number
  /** Its environment: a secret value in it is masked out of the stored output. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Its `exec.env.secret`: names in `env` whose values are masked whatever the name. */
  readonly secret?: readonly string[]
  /** No remote held the key when the run asked: its upload asks none first. */
  readonly absent?: boolean
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
   * else the first remote holding it, and resolves its output, both streams
   * in the order written; null when
   * none holds it. A key restored here and then saved is not uploaded
   * again.
   */
  restore(key: string, task: ArtifactTask): Promise<CapturedChunk[] | null>
  /**
   * Entry `key`'s output alone, laying no file; null when no cache holds
   * it. An `exec.remote: 'only'` task's files stay off this disk.
   */
  output(key: string): Promise<CapturedChunk[] | null>
  /**
   * True once a remote the run reads holds entry `key`, this machine's
   * entry uploaded to those it writes when none does: another machine of
   * the run reads the remotes alone. False when none holds it and none took it.
   */
  share(key: string): Promise<boolean>
  /**
   * This machine's entry `key` uploaded over each written remote's copy,
   * which another machine of the run found corrupt. True when one took it.
   */
  resend(key: string): Promise<boolean>
  /**
   * Whether a remote the workspace writes took entry `key` when `save`
   * uploaded it; undefined when it writes none. Another machine of the
   * run reads the remotes alone, so false there means only this one has it.
   */
  uploaded?(key: string): Promise<boolean | undefined>
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
      const mine = (f: string) => task.others?.has(f) !== true
      const files = tree.files.filter(mine)
      const ws = wsFiles.filter(mine)
      const mask = secretMask([process.env, run.env ?? {}], run.secret)
      const log = encodeOutputLog(run.output)
      await cache.save({
        hash: key,
        projectDir: task.projectDir,
        outputFiles: files,
        ...(tree.emptyDirs.length > 0 ? { outputDirs: tree.emptyDirs } : {}),
        workspaceRoot,
        ...(ws.length > 0 ? { workspaceOutputFiles: ws } : {}),
        ...(run.absent === true ? { absent: true } : {}),
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
      return decodeOutputLog(entry.stdout)
    },

    async output(key) {
      const entry = await (cache.getSaved ? cache.getSaved(key) : cache.get(key))
      return entry === null ? null : decodeOutputLog(entry.stdout)
    },

    share: (key) => cache.share?.(key) ?? Promise.resolve(false),
    resend: (key) => cache.resend?.(key) ?? Promise.resolve(false),
    uploaded: (key) => cache.uploaded?.(key) ?? Promise.resolve(undefined),
  }
}

/**
 * What a run's cache is read under, for a machine that runs its tasks
 * (`ExecutorContext.cacheFacts`, `CommandContext.artifactsFor`): the
 * refs the run worked out, so that machine reads as the run would, and
 * the access each remote lent, by plugin.
 */
export interface CacheFacts {
  /** `CacheContext.refs`. */
  readonly refs: readonly string[]
  /** Plugin name → the token its remote's `lend` gave. */
  readonly lent: Readonly<Record<string, string>>
  /** Epoch ms: the first lent token's end, before which to ask again. */
  readonly expiresAt?: number
}

/** The run's `CacheFacts`: each readable remote's `lend`, asked now; one that throws lends nothing, said. */
export async function cacheFacts(
  remotes: readonly ResolvedRemote[],
  refs: readonly string[],
): Promise<CacheFacts> {
  const lent: Record<string, string> = {}
  let expiresAt: number | undefined
  await Promise.all(
    remotes.map(async (r) => {
      if (r.plugin === undefined || r.remote.lend === undefined || !r.read) return
      const got = await r.remote.lend().catch((err: unknown) => {
        // Said: unsaid, the run's workers went without this remote and no line said why.
        const message = err instanceof Error ? err.message : String(err)
        sayRemoteFault(
          r,
          new Error(`lend of ${r.plugin}'s access failed: ${message}`, { cause: err }),
        )
        return undefined
      })
      if (got === undefined) return
      lent[r.plugin] = got.token
      if (got.expiresAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, got.expiresAt)
    }),
  )
  return { refs, lent, ...(expiresAt === undefined ? {} : { expiresAt }) }
}
