// The one entry a distributed executor's worker runs tasks through: a task
// another machine placed runs here as the local floor would run it, with
// this machine's sandbox walls, paths, probes and package manager.

import type { SandboxConfig } from '../config.js'
import { answerRuntime } from '../cache/index.js'
import {
  BoundedCapture,
  packageManagerPath,
  sampleTrees,
  type CapturedChunk,
  type ExecuteRequest,
  type ExecuteResult,
  type ReadableOutputs,
  type TreeUsage,
} from '../exec/index.js'
import { dependencyReads, sandboxRequestFor, sweepPlaceholders } from '../sandbox/index.js'
import { localFloor, type LocalFloor } from './local-floor.js'

/** A task's `exec.sandbox` as a worker receives it: built into walls on this machine. */
export interface WorkerSandbox {
  readonly config: SandboxConfig
  /** Keyed input files it may read: absolute paths. */
  readonly keyed?: readonly string[]
  /** Its dependencies' outputs it may read: absolute paths. */
  readonly reads?: readonly string[]
  /** The heads walked for them: a refused read under one is reported. */
  readonly reported?: readonly string[]
  /**
   * In place of `reads` and `reported`: the dependencies whose outputs it
   * may read (`ExecuteSandbox.readableDeps`, on this machine's paths),
   * listed here as the task is prepared, after they are restored.
   */
  readonly readable?: readonly ReadableOutputs[]
}

/** A task to run here: the request core would build, with its sandbox not yet built. */
export interface WorkerTask extends Omit<
  ExecuteRequest,
  'sandbox' | 'capture' | 'onStdout' | 'onStderr' | 'workspaceRoot'
> {
  readonly projectDir: string
  /** The projects nested in its own (their dirs): a wall its grants do not reach. */
  readonly nested: readonly string[]
  readonly sandbox?: WorkerSandbox
}

/** A task whose sandbox is built: its placeholders exist until `sweep`. */
export interface PreparedTask {
  /** Runs it on the local floor; both streams kept as one bounded capture, in written order. */
  run(): Promise<ExecuteResult & { readonly output: CapturedChunk[] }>
  /** Removes each bind the task never wrote: it is not its output. */
  sweep(): Promise<void>
}

export interface WorkerRuntime {
  /**
   * Builds the task's sandbox here. Separate from `run`: a worker lists
   * the files under the task before the command and after its
   * placeholders exist, so a placeholder is not read as a stray.
   */
  prepare(task: WorkerTask): Promise<PreparedTask>
  /** A runtime probe's answer here, once per (dir, command). */
  probe(command: string, dir: string, workspace: boolean): Promise<string>
  /** The `npm_execpath` core gives a local task here. */
  packageManager(): string | null
  /** CPU and memory of running process trees, by root pid. */
  sample(roots: readonly number[]): Promise<ReadonlyMap<number, TreeUsage>>
  /** Arms the sandbox for `sandboxes` from the next sandboxed task on; servers keep running. */
  rearm(sandboxes: readonly SandboxConfig[]): Promise<void>
  /** Stops server `taskId` if this started it. */
  stop(taskId: string): Promise<void>
  /** Stops its servers and the sandbox runtime it armed. */
  close(): Promise<void>
}

export function workerRuntime(opts: {
  /** This machine's checkout of the workspace. */
  readonly root: string
  /** `onServer` hears each server's pid as it spawns, and `undefined` as it stops. */
  readonly onServer?: (taskId: string, pid: number | undefined) => void
}): WorkerRuntime {
  // Made at the first task or sandbox list: arming the sandbox is not free.
  let floor: LocalFloor | undefined
  const floorFor = (sandboxes: readonly SandboxConfig[] = []): LocalFloor =>
    (floor ??= localFloor(sandboxes, opts.onServer))
  const probes = new Map<string, Promise<string>>()
  return {
    async prepare(task) {
      const { projectDir, nested, sandbox, ...req } = task
      const listed =
        sandbox?.readable === undefined
          ? undefined
          : await dependencyReads(
              sandbox.readable.map((d) => ({
                id: d.taskId,
                projectDir: d.projectDir,
                config: { outputs: d.outputs },
              })),
              opts.root,
            )
      const sb =
        sandbox === undefined
          ? undefined
          : await sandboxRequestFor(
              { projectDir },
              sandbox.config,
              opts.root,
              sandbox.keyed === undefined ? undefined : new Set(sandbox.keyed),
              nested,
              undefined,
              listed?.reads ?? sandbox.reads ?? [],
              listed?.reported ?? sandbox.reported ?? [],
            )
      return {
        async run() {
          const output = new BoundedCapture()
          const res = await floorFor().execute({
            ...req,
            workspaceRoot: opts.root,
            capture: { stdout: false, stderr: false },
            onStdout: (t) => output.push(t),
            onStderr: (t) => output.push(t, true),
            ...(sb === undefined ? {} : { sandbox: sb.sandbox }),
          })
          return { ...res, output: output.chunks() }
        },
        async sweep() {
          if (sb !== undefined) await sweepPlaceholders(sb.placeholders)
        },
      }
    },
    probe(command, dir, workspace) {
      const k = `${dir}\0${command}`
      let p = probes.get(k)
      if (p === undefined) {
        p = answerRuntime(command, dir, opts.root, workspace)
        probes.set(k, p)
      }
      return p
    },
    packageManager: () => packageManagerPath(opts.root),
    sample: (roots) => sampleTrees(roots),
    async rearm(sandboxes) {
      if (floor === undefined) floorFor(sandboxes)
      else await floor.rearm(sandboxes)
    },
    stop: (taskId) => floor?.stop(taskId) ?? Promise.resolve(),
    close: () => floor?.close() ?? Promise.resolve(),
  }
}
