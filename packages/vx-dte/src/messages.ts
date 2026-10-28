// What the orchestrator and its workers say to each other through the relay
// (the relay never reads it): orders and status only. Every task's files
// and output go through the workspace's cache, by the keys these name.

import type { CacheFacts, CapturedChunk, ExecuteResult, SandboxConfig } from '@vzn/vx'

/**
 * A worker says what it holds every this many heartbeats, and a task's
 * lease is three of them. Every heartbeat (2026-10-25: the fastest, not
 * a free plan's message count): a task its worker dropped while alive
 * goes back in 15 s, not 90.
 */
export const HELD_EVERY = 1

/** A worker's `join` info. */
export interface WorkerInfo {
  readonly v: 1
  /** `WorkerSpawn.id` (`VX_DTE_WORKER`), for a worker the run started. */
  readonly id?: string
  /** What its machine has (core's `machineParallelism`, `machineMemoryBytes`), not what its size says. */
  readonly cores: number
  readonly memory: number
  /** Its machine's platform, `os-arch` (`linux-x64`): a task naming `exec.platforms` goes only to a worker of its platform. */
  readonly platform?: string
  /** Its checkout's tree: a worker with other tracked files than the run is refused. */
  readonly tree: string
  /** When its `vx` started, wall-clock ms: the run's trace splits its warm-up there. */
  readonly booted?: number
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
  /**
   * The run reads no cache (`--force`): a success is saved under `key`, which
   * keeps an entry it holds, and under `runKey`, whose fresh bytes this run's
   * machines restore.
   */
  fresh?: true
  /** The run's probe found `key` in no cache: its upload asks the remote nothing first. */
  absent?: true
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
  /** Its `exec.sandbox` and the projects nested in its own, workspace-relative: it starts inside it. */
  sandbox?: { config: SandboxConfig; nested: string[] }
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
  /** Part of an order's `deps`, ahead of the batch whose order was too long for one frame. */
  | { type: 'deps'; task: string; deps: DepOrder[] }
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
 * by what is free, not only by what history booked (2026-10-23: "you
 * watch instruments and play most efficient as they go").
 */
export interface Load {
  readonly cpu: number
  readonly memory: number
  /** Cores its running tasks' process trees used over the last look: the rest of `cpu` is no task's. */
  readonly tasks?: number
  /**
   * Cores busy on average since the worker started: the summary's
   * `machine avg`. A worker sends few frames, so the run cannot average
   * `cpu` (one that sent 3, each as a task started, read 0.6 of 2.0 used).
   */
  readonly avg?: number
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
  /**
   * Ahead of an `end` too long for one relay frame, some of its lists:
   * the `end` that follows adds its own to them. One `end` with a sandboxed
   * task's 9000 violations was over the relay's 1 MiB, and the run waited
   * for it (2026-10-25).
   */
  | ({ type: 'part'; task: string } & Partial<Pick<WiredResult, PartList>>)

/**
 * A message's JSON in UTF-8 bytes, what a relay frame holds: counted in
 * UTF-16 units, a part of CJK output sealed past the relay's 1 MiB and its
 * result never arrived (2026-10-25).
 */
export const bytesOf = (body: unknown): number => Buffer.byteLength(JSON.stringify(body))

/** The lists a long result sends ahead of its `end`, in parts. */
export const PART_LISTS = ['violations', 'changed', 'removed', 'output'] as const
export type PartList = (typeof PART_LISTS)[number]

/** A result as JSON carries it: its output stays in the cache entry, and a violation's time is a string. */
export type WiredResult = Omit<ExecuteResult, 'violations' | 'outputs' | 'stdout' | 'stderr'> & {
  violations?: (Omit<ExecuteResult['violations'][number], 'timestamp'> & { timestamp: string })[]
  /** The share of a core each runnable thread got on the worker while it ran (`ExecuteResult.machine.cpuShare`). */
  cpuShare?: number
  /** Workspace-relative upstream outputs the task removed: this machine removes them too. */
  removed?: string[]
  /** Dependency keys whose remote copy did not read back: this machine sends its own over them. */
  unread?: string[]
  /**
   * No remote took its entry's upload (too big, a 429): its files are on
   * that worker alone, and its output comes here in `output`.
   */
  unshared?: true
  /** Its output, both streams in the order written, when `unshared`. */
  output?: CapturedChunk[]
}

/**
 * Names whose value is the worker's own: the orchestrator sends one only
 * when a task's `env.define` sets it, a value its key folds.
 */
export const HOST_ENV = [
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'npm_execpath',
  'PNPM_HOME',
  'COREPACK_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
]
