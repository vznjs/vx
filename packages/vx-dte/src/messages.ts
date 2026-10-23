// What the orchestrator and its workers say to each other through the relay
// (the relay never reads it): orders and status only. Every task's files
// and output go through the workspace's cache, by the keys these name.

import type { CacheFacts, ExecuteResult, SandboxConfig } from '@vzn/vx'

/**
 * A worker says what it holds every this many heartbeats. Each says is a
 * relay message its host bills; at one per heartbeat they were most of a
 * run's traffic (2026-10-22), and the relay's own heartbeat finds a dead
 * worker sooner.
 */
export const HELD_EVERY = 6

/** A worker's `join` info. */
export interface WorkerInfo {
  readonly v: 1
  /** `WorkerSpawn.id` (`VX_DTE_WORKER`), for a worker the run started. */
  readonly id?: string
  /** What its machine has (core's `machineParallelism`, `machineMemoryBytes`), not what its size says. */
  readonly cores: number
  readonly memory: number
  /** Its checkout's tree: a worker with other tracked files than the run is refused. */
  readonly tree: string
}

/** A task whose files the worker restores before it runs one that needs them. */
export interface DepOrder {
  task: string
  /** Where its entry is: its cache key, or the run key it was saved under. */
  key: string
  /** Workspace-relative. */
  project: string
  outputs: { files: string[]; workspaceFiles: string[] }
}

/** One task a worker is sent. */
export interface RunOrder {
  task: string
  /** Its cache key, which a success with no violation is saved under; absent, uncached. */
  key?: string
  /** What anything else is saved under: no hit ever serves it. */
  runKey: string
  /** The tasks it depends on, transitively, whose files the worker does not hold yet. */
  deps: DepOrder[]
  /** Workspace-relative projects inside `project`, whose files are not its outputs. */
  nested: string[]
  command: string
  /** Workspace-relative, as `project` is. */
  cwd: string
  project: string
  env: Record<string, string>
  timeoutMs?: number
  outputs: { files: string[]; workspaceFiles: string[] }
  /** Its recorded peak: the worker starts it when that much is free. */
  cores: number
  memory: number
  /**
   * Its `exec.sandbox`, and for a cached task the projects its key answers
   * for (workspace-relative): the worker builds the request on its own
   * paths and OS (`sandboxRequestFor`), as its orchestrator may run another.
   */
  sandbox?: { config: SandboxConfig; keyed?: string[] }
  /** Its persistent dependencies (`ServerSpec`), `cwd` workspace-relative: the worker starts each once. */
  servers?: ServerOrder[]
  /** The runtime probes its key folds, as the orchestrator answered them: the worker's must answer the same. */
  runtime?: RuntimeOrder[]
}

export interface RuntimeOrder {
  command: string
  output: string
  /** A `workspaceRuntime` probe, run at the root; else in `project`. */
  workspace?: true
}

export interface ServerOrder {
  task: string
  command: string
  cwd: string
  env: Record<string, string>
  readyWhen?: string
  timeoutMs?: number
}

export type ToWorker =
  /** Tasks that fit what it has free, each begun at once; `root` is swapped for the worker's in `env`. */
  | {
      type: 'batch'
      root: string
      /** `root`'s real path, as sandbox paths spell it. */
      realRoot: string
      tasks: RunOrder[]
      /** The run's sandboxed tasks' `exec.sandbox`, in a worker's first batch that has a sandboxed task. */
      sandboxes?: SandboxConfig[]
    }
  | { type: 'cancel'; task: string }
  /**
   * It was taken into the run, under the name the run's output gives it,
   * and reads the cache as the run does: its refs, and the access the
   * run's remotes lend, for one with none of its own.
   */
  | {
      type: 'welcome'
      name: string
      cache: CacheFacts
    }
  /** The run's remotes lent again, before the last tokens end. */
  | { type: 'cache'; cache: CacheFacts }
  | { type: 'refused'; reason: string }
  /** The run needs it no more: it leaves. */
  | { type: 'exit' }

/**
 * What its machine uses now: cores busy over the last second and bytes of
 * memory in use. Each frame a worker sends carries it, so the run places
 * by what is free, not only by what history booked (M, 2026-10-23: "you
 * watch instruments and play most efficient as they go").
 */
export interface Load {
  readonly cpu: number
  readonly memory: number
}

export type ToOrchestrator =
  /** It began the task. */
  | { type: 'start'; task: string; load?: Load }
  /** Its command is done; its outputs save now, its cores are free. */
  | { type: 'ran'; task: string; load?: Load }
  /** Each heartbeat while it runs any: what it runs, which renews its lease on each. */
  | { type: 'held'; running: string[]; load?: Load }
  /** It could not run a task it began, not a non-zero exit: a full disk, a failed unpack. */
  | { type: 'fault'; task: string; reason: string }
  /** It ran the task and saved it under `key`; its output is in that entry. */
  | { type: 'end'; task: string; key: string; result: WiredResult; load?: Load }

/** A result as JSON carries it: its output stays in the cache entry, and a violation's time is a string. */
export type WiredResult = Omit<ExecuteResult, 'violations' | 'outputs' | 'stdout' | 'stderr'> & {
  violations?: (Omit<ExecuteResult['violations'][number], 'timestamp'> & { timestamp: string })[]
}

/**
 * Whether a task asking `need` begins beside the work holding `used` of
 * a worker's `of`: while a core is free and its memory fits. Packed only
 * to whole needs, a worker kept the cores no queued task fit: main's
 * booked 3.2 of 4 and used 2.6 (2026-10-23). A task asking the whole
 * worker waits for an idle one.
 */
export function shares(
  used: { readonly cores: number; readonly memory: number },
  need: { readonly cores: number; readonly memory: number },
  of: { readonly cores: number; readonly memory: number },
): boolean {
  return need.cores < of.cores && used.cores < of.cores && used.memory + need.memory <= of.memory
}
