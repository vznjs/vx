// What the orchestrator and its agents say to each other through the relay
// (the relay never reads it): orders and status only. Every task's files
// and output go through the workspace's cache, by the keys these name.

import type { CacheFacts, ExecuteResult, ExecuteSandbox, SandboxConfig } from '@vzn/vx'

/** An agent's `join` info. */
export interface AgentInfo {
  readonly v: 1
  /** `AgentSpawn.id` (`VX_DTE_AGENT`), for an agent the run started. */
  readonly id?: string
  /** What its machine has (core's `machineParallelism`, `machineMemoryBytes`), not what its size says. */
  readonly cores: number
  readonly memory: number
  /** Its checkout's tree: an agent with other tracked files than the run is refused. */
  readonly tree: string
}

/** A task whose files the agent restores before it runs one that needs them. */
export interface DepOrder {
  task: string
  /** Where its entry is: its cache key, or the run key it was saved under. */
  key: string
  /** Workspace-relative. */
  project: string
  outputs: { files: string[]; workspaceFiles: string[] }
}

/** One task an agent is sent. */
export interface RunOrder {
  task: string
  /** Its cache key, which a success with no violation is saved under; absent, uncached. */
  key?: string
  /** What anything else is saved under: no hit ever serves it. */
  runKey: string
  /** The tasks it depends on, transitively, whose files the agent does not hold yet. */
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
  /** Its recorded peak: the agent starts it when that much is free. */
  cores: number
  memory: number
  /** The request's sandbox, in the orchestrator's paths; the agent swaps in its own. */
  sandbox?: ExecuteSandbox
  /** Workspace-relative paths its write grants bind, which must exist first. */
  binds?: { path: string; dir: boolean }[]
}

export type ToAgent =
  /** Tasks for its free capacity and a little more; `root` is swapped for the agent's in `env`. */
  | {
      type: 'batch'
      root: string
      /** `root`'s real path, as sandbox paths spell it. */
      realRoot: string
      tasks: RunOrder[]
      /** The run's sandboxed tasks' `exec.sandbox`, in an agent's first batch that has a sandboxed task. */
      sandboxes?: SandboxConfig[]
    }
  | { type: 'cancel'; task: string }
  /** Give back a task still in its queue (`withdrawn`); one it began it keeps. */
  | { type: 'withdraw'; task: string }
  /**
   * It was taken into the run, under the name the run's output gives it,
   * and reads the cache as the run does: its refs, and the access the
   * run's remotes lend, for one with none of its own.
   */
  | {
      type: 'welcome'
      name: string
      cache: CacheFacts
      /** What it may run at once: its machine, held to the size it was started as. */
      cores: number
      memory: number
    }
  /** The run's remotes lent again, before the last tokens end. */
  | { type: 'cache'; cache: CacheFacts }
  | { type: 'refused'; reason: string }
  /** The run needs it no more: it leaves. */
  | { type: 'exit' }

export type ToOrchestrator =
  /** It began the task: until then the task waits in its queue. */
  | { type: 'start'; task: string }
  /** Each heartbeat while it holds any: what it runs and what waits in its queue, which renews its lease on each. */
  | { type: 'held'; running: string[]; queued: string[] }
  /** It could not run a task it began, not a non-zero exit: a full disk, a failed unpack. */
  | { type: 'fault'; task: string; reason: string }
  /** It gave back a task from its queue, unbegun: another agent runs it. */
  | { type: 'withdrawn'; task: string }
  /** It ran the task and saved it under `key`; its output is in that entry. */
  | { type: 'end'; task: string; key: string; result: WiredResult }

/** A result as JSON carries it: its output stays in the cache entry, and a violation's time is a string. */
export type WiredResult = Omit<ExecuteResult, 'violations' | 'outputs' | 'stdout' | 'stderr'> & {
  violations?: (Omit<ExecuteResult['violations'][number], 'timestamp'> & { timestamp: string })[]
}
