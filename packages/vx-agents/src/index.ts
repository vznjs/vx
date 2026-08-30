// @vzn/vx-agents — run tasks on a fleet of persistent workers.
//
//   import { defineWorkspace } from '@vzn/vx'
//   import { agents } from '@vzn/vx-agents'
//   export default defineWorkspace({
//     plugins: [agents({ endpoint: 'https://sync.internal:8787' }), …],
//   })
//
// Declared before the local executor it takes every task the local one would
// have run. With no endpoint (and no `VX_AGENTS_ENDPOINT`) it declines and
// costs nothing, so a workspace can declare it unconditionally.
//
// vx keeps the scheduler. This dispatches ONE task at a time, in the order
// core decided, and streams the worker's output back into the same terminal
// frames a local run uses. What comes back is an exit code and bytes; the
// task's OUTPUTS reach whoever needs them through the remote cache, which is
// why a cache plugin is not optional here.

import type { ExecuteRequest, ExecuteResult, TaskExecutor, TaskPlacement, VxPlugin } from '@vzn/vx'
import { UserError } from '@vzn/vx'
import { SyncClient } from './client.js'
import type { AssignmentResult, Requirement, RunEvent } from './protocol.js'

export { SyncClient, SyncError, type SyncClientOptions } from './client.js'
export { SyncServer, type SyncServerOptions } from './sync.js'
export { Worker, lockDigest, type WorkerOptions } from './worker.js'
export {
  satisfies,
  WIRE_VERSION,
  type Assignment,
  type AssignmentResult,
  type Requirement,
  type RunEvent,
  type WorkerCapabilities,
} from './protocol.js'

export interface AgentsPluginOptions {
  /** Synchronizer base URL. Absent (and no `VX_AGENTS_ENDPOINT`) → declines. */
  endpoint?: string
  /** Shared secret, if the synchronizer requires one. */
  authToken?: string
  /** How many assignments to keep in flight. This is the fleet's parallelism. */
  concurrency?: number
  /** Commit the workers check out. Defaults to `VX_AGENTS_COMMIT` or `git rev-parse HEAD`. */
  commit?: string
  /** Clone URL workers fetch from. Defaults to `VX_AGENTS_REMOTE` or `origin`. */
  remote?: string
}

export const AGENTS_PLUGIN = 'vx-agents'

const DEFAULT_CONCURRENCY = 8

/**
 * Placement. A persistent task is local by construction (its port lives on
 * this machine) and vx never offers one to an executor; beyond that a worker
 * runs a scoped `run()` of the task, so anything a local shell can do it can
 * do — including a non-cacheable task, since there is no input tree to
 * describe.
 */
export function acceptsTask(task: TaskPlacement): boolean {
  return !task.pinnedLocal
}

/** `exec.resources` as a routing requirement. Absent axes constrain nothing. */
export function requirementOf(task: TaskPlacement): Requirement {
  const r = task.resources
  return {
    ...(r?.image === undefined ? {} : { image: r.image }),
    ...(r?.cpus === undefined ? {} : { cores: r.cpus }),
    ...(r?.memory === undefined ? {} : { memory: r.memory }),
  }
}

/** `${project}#${task}` → its two halves. */
export function splitTaskId(taskId: string): { project: string; task: string } {
  const hash = taskId.indexOf('#')
  return { project: taskId.slice(0, hash), task: taskId.slice(hash + 1) }
}

export function agents(options: AgentsPluginOptions = {}): VxPlugin {
  let client: SyncClient | undefined
  let opened: Promise<string> | undefined
  let runId: string | undefined
  const pending = new Map<string, PendingAssignment>()
  const requirements = new Map<string, Requirement>()

  return {
    name: AGENTS_PLUGIN,
    executor(ctx): TaskExecutor | undefined {
      const endpoint = options.endpoint ?? Bun.env['VX_AGENTS_ENDPOINT']
      if (endpoint === undefined || endpoint === '') return undefined
      const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
      client = new SyncClient({
        endpoint,
        ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      })
      const active = client

      return {
        name: 'vx/agents',
        // Reported remote so the scheduler admits these against their own pool
        // rather than local worker slots — the fleet is not this machine's CPUs.
        remote: true,
        capacity: concurrency,
        accepts(task: TaskPlacement): boolean {
          if (!acceptsTask(task)) return false
          requirements.set(task.taskId, requirementOf(task))
          return true
        },
        async execute(req: ExecuteRequest): Promise<ExecuteResult> {
          opened ??= openRun(active, options, ctx.workspaceRoot, pending)
          runId = await opened
          const { project, task } = splitTaskId(req.taskId)
          const started = Bun.nanoseconds()
          const assignmentId = await active.dispatch(runId, {
            taskId: req.taskId,
            project,
            task,
            forwardArgs: [...req.forwardArgs],
            requirement: requirements.get(req.taskId) ?? {},
          })
          const result = await new Promise<AssignmentResult>((resolve) => {
            pending.set(assignmentId, {
              onStdout: req.onStdout,
              onStderr: req.onStderr,
              resolve,
            })
          })
          pending.delete(assignmentId)
          if (result.error !== undefined) {
            // The worker could not run the task at all. That is an environment
            // failure, not the task's — say so plainly rather than as an
            // "internal error in <task>".
            throw new UserError(`vx/agents: ${req.taskId}: ${result.error}`)
          }
          return {
            exitCode: result.exitCode,
            durationMs: Number(Bun.nanoseconds() - started) / 1e6,
            stdout: '',
            stderr: '',
            violations: [],
            where: result.workerId,
          } as unknown as ExecuteResult
        },
      }
    },
    async teardown(): Promise<void> {
      // Closing releases every worker this run leased. Skipping it would leave
      // the fleet holding them until their lease timed out, starving whatever
      // ran next.
      if (client !== undefined && runId !== undefined) {
        await client.closeRun(runId).catch(() => undefined)
      }
      client = undefined
      opened = undefined
      runId = undefined
      pending.clear()
      requirements.clear()
    },
  } as VxPlugin
}

interface PendingAssignment {
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  readonly resolve: (result: AssignmentResult) => void
}

/**
 * Open the run and subscribe BEFORE the first dispatch.
 *
 * Order matters: dispatching first would race the subscription, and a result
 * that arrived in that window would be delivered to nobody — the task would
 * hang forever with the worker already finished.
 */
async function openRun(
  client: SyncClient,
  options: AgentsPluginOptions,
  workspaceRoot: string,
  pending: Map<string, PendingAssignment>,
): Promise<string> {
  const commit = options.commit ?? Bun.env['VX_AGENTS_COMMIT'] ?? (await gitHead(workspaceRoot))
  const remote = options.remote ?? Bun.env['VX_AGENTS_REMOTE'] ?? (await gitRemote(workspaceRoot))
  const run = await client.openRun(commit, remote)
  await client.subscribe(run.runId, (event: RunEvent) => {
    const waiter = pending.get(event.assignmentId)
    if (waiter === undefined) return
    if (event.kind === 'output') {
      if (event.stream === 'out') waiter.onStdout(event.chunk)
      else waiter.onStderr(event.chunk)
    } else if (event.kind === 'result') {
      waiter.resolve(event.result)
    }
  })
  return run.runId
}

async function gitHead(cwd: string): Promise<string> {
  return await gitOut(['rev-parse', 'HEAD'], cwd)
}

async function gitRemote(cwd: string): Promise<string> {
  return await gitOut(['remote', 'get-url', 'origin'], cwd)
}

async function gitOut(args: readonly string[], cwd: string): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) {
    throw new UserError(
      `vx/agents: could not read \`git ${args.join(' ')}\` — workers fetch the run's commit ` +
        `from a remote, so both must be resolvable (or set VX_AGENTS_COMMIT / VX_AGENTS_REMOTE)`,
    )
  }
  return out.trim()
}
