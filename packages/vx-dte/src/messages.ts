// What the orchestrator and its workers say to each other through the relay
// (the relay never reads it): orders and status only. Every task's files
// and output go through the workspace's cache, by the keys these name.

import type { CacheFacts, CapturedChunk, ExecuteResult, SandboxConfig } from '@vzn/vx'

/** How many tracked files a worker's `changed` names: one past it says there are more. */
export const CHANGED_NAMED = 3

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
  /** Tracked files it changed after checkout (`changedFiles`), a few: a refusal for another tree names them. */
  readonly changed?: readonly string[]
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
  /** `HOST_ENV` names its key folds as unset: the worker leaves them unset, not its own. */
  unset?: string[]
  /** Its `env.define` sets PATH or its `inputs.env` keys it: the worker runs it as sent, not its own. */
  path?: true
  /** Its `exec.env.secret`: the names in `env` whose values its saved output masks. */
  secret?: string[]
  timeoutMs?: number
  /** Its files may come to the orchestrator after its `end`, which then carries its output (`log`). */
  trail?: true
  outputs: { files: string[]; workspaceFiles: string[] }
  /** Its recorded peak: the worker starts it when that much is free. */
  cores: number
  memory: number
  /**
   * Its `exec.sandbox`, and for a cached task the projects its key answers
   * for (workspace-relative): the worker builds the request on its own
   * paths and OS (`sandboxRequestFor`), as its orchestrator may run another;
   * `readable`, the dependencies whose outputs it may read: the worker
   * lists their files itself, once it has restored them. Listed by the
   * orchestrator, a task waited for each dependency's files to reach that
   * machine before it could be sent (2026-11-13).
   */
  sandbox?: { config: SandboxConfig; keyed?: string[]; readable?: ReadableOrder[] }
  /** Its persistent dependencies (`ServerSpec`), `cwd` workspace-relative: the worker starts each once. */
  servers?: ServerOrder[]
  /** The runtime probes its key includes, as the orchestrator answered them: the worker's must answer the same. */
  runtime?: RuntimeOrder[]
}

/**
 * A dependency as an order carries it: whole the first time its worker is
 * sent it under that key, then by its task's name alone.
 */
export type WiredDep = DepOrder | string

/** A `RunOrder` as it travels: its deps `WiredDep`s, made whole again by the worker. */
export type SentOrder = Omit<RunOrder, 'deps'> & { deps: WiredDep[] }

/** A dependency whose declared outputs a sandboxed task may read, `project` workspace-relative. */
export interface ReadableOrder {
  task: string
  project: string
  files: string[]
  workspaceFiles?: string[]
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
  /** Its `env.define` sets PATH: the worker runs it as sent (`RunOrder.path`). */
  path?: true
  readyWhen?: string
  timeoutMs?: number
  /** Its `exec.sandbox` and the projects nested in its own, workspace-relative: it starts inside it. */
  sandbox?: { config: SandboxConfig; nested: string[] }
}

export type ToWorker =
  /**
   * Tasks that fit what it has free: taken, each runs at once. `n` counts
   * its batches, so its report says which it had read.
   */
  | {
      type: 'batch'
      n: number
      root: string
      /** `root`'s real path, as sandbox paths spell it. */
      realRoot: string
      tasks: SentOrder[]
      /** The run's sandboxed tasks' `exec.sandbox`, in a worker's first batch that has a sandboxed task. */
      sandboxes?: SandboxConfig[]
    }
  /** Part of an order's `deps`, ahead of the batch whose order was too long for one frame. */
  | { type: 'deps'; task: string; deps: WiredDep[] }
  | { type: 'cancel'; task: string }
  /** No task left in the run uses persistent task `task`: it stops here. */
  | { type: 'unserve'; task: string }
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
 * memory in use. Each frame a worker sends carries it, so the run places by
 * what is free, not only by what history booked.
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
  /** Cores the worker's own process used on average since it started: what the run's bookkeeping costs it. */
  readonly self?: number
  /** When it was read, by the worker's clock: its task times are read against it. */
  readonly at?: number
  /** Each server it runs, its base as fitted (`server-fit.ts`): cores it uses with no dependant's work. */
  readonly servers?: Record<string, number>
  /** Each server it started, ms from its spawn to its first dependant's: what that task waited. */
  readonly starts?: Record<string, number>
}

/** A task's times on its worker, epoch ms by the worker's clock: begun, command ended. */
export interface Ran {
  readonly startedAt: number
  readonly ranAt: number
}

export type ToOrchestrator =
  /**
   * Its command is done; its outputs save now, its cores are free. Never
   * sent alone: it rides the next message, or its `end` says it.
   */
  | ({ type: 'ran'; task: string; load?: Load } & Ran)
  /**
   * A heartbeat with nothing else said: what it runs, the last batch it
   * read, its live load. A task of that batch or before it no longer
   * names goes back.
   */
  | { type: 'report'; running: string[]; batch: number; load: Load }
  /** Messages said at one moment, as one frame: waiting `ran`s and the event they ride. */
  | { type: 'together'; messages: ToOrchestrator[] }
  /** It could not run a task it began, not a non-zero exit: a full disk, a failed unpack. */
  | { type: 'fault'; task: string; reason: string; load?: Load }
  /** It ran the task and saved it under `key`; its output is in that entry. */
  | ({
      type: 'end'
      task: string
      key: string
      result: WiredResult
      endedAt: number
      /** Where its time since its command went, ms: checking what it left, saving here, the remotes taking it. */
      spent?: { check: number; save: number; upload: number }
      /**
       * Its output as its entry holds it, for a `trail` order that passed: the
       * orchestrator ends the task with it before the entry is there. Absent
       * when too long for a frame; the entry is then read first, as ever.
       */
      log?: CapturedChunk[]
      load?: Load
    } & Ran)
  /**
   * Ahead of an `end` too long for one relay frame, some of its lists: the
   * `end` that follows adds its own to them. One `end` with a sandboxed task's
   * 9000 violations was over the relay's 1 MiB, and the run waited for it.
   */
  | ({ type: 'part'; task: string; load?: Load } & Partial<Pick<WiredResult, PartList>>)

/**
 * A message's JSON in UTF-8 bytes, what a relay frame holds: counted in UTF-16
 * units, a part of CJK output sealed past the relay's 1 MiB and its result
 * never arrived.
 */
export const bytesOf = (body: unknown): number => Buffer.byteLength(JSON.stringify(body))

/** The longest output an `end` carries (`log`): past it, the orchestrator reads the entry. */
export const TRAIL_LOG_BYTES = 256 * 1024

/** The lists a long result sends ahead of its `end`, in parts. */
export const PART_LISTS = ['violations', 'changed', 'removed'] as const
export type PartList = (typeof PART_LISTS)[number]

/** A result as JSON carries it: its output stays in the cache entry, and a violation's time is a string. */
export type WiredResult = Omit<ExecuteResult, 'violations' | 'outputs' | 'stdout' | 'stderr'> & {
  violations?: (Omit<ExecuteResult['violations'][number], 'timestamp'> & { timestamp: string })[]
  /** The share of a core each runnable thread got on the worker while it ran (`ExecuteResult.machine.cpuShare`). */
  cpuShare?: number
  /** Workspace-relative files under its outputs the task removed (an upstream's, a committed one): this machine removes them too. */
  removed?: string[]
  /** Dependency keys whose remote copy did not read back: this machine sends its own over them. */
  unread?: string[]
}

/**
 * Names whose value is the worker's own: the orchestrator sends one only
 * when a task's `env.define` sets it or its `inputs.env` keys it, a value
 * its key includes; a keyed one unset there is unset on the worker too
 * (`RunOrder.unset`).
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
