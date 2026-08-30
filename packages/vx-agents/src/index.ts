// Public API for @vzn/vx-agents — the agent-pool executor.
//
// Usage in vx.workspace.ts:
//   import { defineWorkspace } from '@vzn/vx'
//   import { agents } from '@vzn/vx-agents'
//   export default defineWorkspace({
//     plugins: [
//       agents({ image: 'my-toolchain:latest', count: 4, prepare: 'bun ci' }),
//       localExecutorPlugin(),
//       localCachePlugin(),
//     ],
//   })
//
// Declared before the local executor, it takes every task the local one would
// have run. Declare it AFTER, or leave `image` unset, and it declines at zero
// cost.

import type { ExecuteRequest, ExecuteResult, TaskExecutor, TaskPlacement, VxPlugin } from '@vzn/vx'
import { AgentPool, type Agent } from './pool.js'
import { createDockerAgent } from './docker.js'
import { nomadAgentFactory, type NomadAgentOptions } from './nomad.js'
import { kubernetesAgentFactory, type KubernetesAgentOptions } from './kubernetes.js'

export {
  AgentPool,
  type Agent,
  type AgentCommand,
  type AgentResult,
  type PoolOptions,
} from './pool.js'
export { createDockerAgent, DockerError, joinPosix, type DockerAgentOptions } from './docker.js'
export {
  envPrefix,
  nomadAgentFactory,
  nomadJobSpec,
  NomadError,
  runningAllocIds,
  shellQuote,
  type NomadAgentOptions,
} from './nomad.js'
export {
  kubernetesAgentFactory,
  KubernetesError,
  podManifest,
  type KubernetesAgentOptions,
} from './kubernetes.js'

export interface AgentsPluginOptions {
  /**
   * Container image for each agent. Absent (and no `VX_AGENTS_IMAGE`) means
   * the plugin declines — a workspace can declare it unconditionally and pay
   * nothing on a machine that has no agents configured.
   */
  image?: string
  /** How many agents to run. Also the executor's scheduler pool size. */
  count?: number
  /** Run once per agent before it takes work — typically the install. */
  prepare?: string
  /** Where the workspace is mounted inside each agent. */
  containerWorkspace?: string
  /** Extra `docker run` arguments, passed through verbatim. */
  runArgs?: readonly string[]
  /** Environment applied to every command on every agent. */
  env?: Readonly<Record<string, string>>
  /** Container name prefix; agents are `<prefix>-0`, `<prefix>-1`, … */
  namePrefix?: string
  /** Whether `prepare` runs once per agent or once for the pool. Defaults to
   *  `'pool'`, because every built-in transport shares one workspace. */
  prepareScope?: 'agent' | 'pool'
  /**
   * Where agents come from. All three keep agents WARM and exec into them —
   * a scheduler's natural unit is a job or a Job that runs to completion, and
   * dispatching one per vx task pays container start every time (measured
   * ~400 ms, against ~30 ms for exec'ing into something already running).
   *
   * `'docker'`  — containers on this machine. No cluster, nothing to install.
   * `'nomad'`   — one job with `count` allocations. Single self-hosted binary.
   * `'kubernetes'` — one long-lived Pod per agent.
   */
  backend?: 'docker' | 'nomad' | 'kubernetes'
  /** CPU per agent. Nomad reads MHz; Kubernetes a quantity like '2' or '500m'. */
  cpu?: number | string
  /** Memory per agent. Nomad reads MiB; Kubernetes a quantity like '2Gi'. */
  memory?: number | string
  /** Nomad: the job id to submit. */
  jobId?: string
  /** Kubernetes: namespace for the agent pods. */
  namespace?: string
  /**
   * How the shared workspace reaches an agent.
   *
   * docker/nomad take a host path (defaulting to the workspace root, which is
   * right for a local cluster). Kubernetes takes a volume source verbatim —
   * `{ hostPath: { path: '/…' } }` on a single node, a ReadWriteMany claim
   * across real ones. Every agent must see the SAME files: vx hashes them
   * here and the command reads them there.
   */
  volume?: string | Readonly<Record<string, unknown>>
  /** Swap the transport — used by the tests, and by anyone whose agents are
   *  not containers (a pod, an ssh host, a reused CI runner). */
  createAgent?: (index: number) => Promise<Agent>
}

export const AGENTS_PLUGIN = 'vx-agents'

const DEFAULT_COUNT = 4
const DEFAULT_WORKSPACE = '/workspace'

/**
 * Placement, and it is deliberately narrower than the REAPI executor's.
 *
 * A persistent task is local by construction (its port lives on this machine),
 * and vx never offers one to an executor. Beyond that an agent can run
 * anything a local shell can, INCLUDING a non-cacheable task: unlike a remote
 * action there is no input tree to describe, so nothing here needs
 * `cache.inputs` to exist.
 */
export function acceptsTask(task: TaskPlacement): boolean {
  return !task.pinnedLocal
}

export function agents(options: AgentsPluginOptions = {}): VxPlugin {
  let pool: AgentPool | undefined
  return {
    name: AGENTS_PLUGIN,
    executor(ctx): TaskExecutor | undefined {
      const image = options.image ?? Bun.env['VX_AGENTS_IMAGE']
      if ((image === undefined || image === '') && options.createAgent === undefined)
        return undefined
      const count = options.count ?? DEFAULT_COUNT
      const containerWorkspace = options.containerWorkspace ?? DEFAULT_WORKSPACE
      const namePrefix = options.namePrefix ?? 'vx-agent'
      const env = options.env ?? {}
      const create =
        options.createAgent ??
        backendFactory(options, {
          image: image!,
          workspaceRoot: ctx.workspaceRoot,
          containerWorkspace,
          namePrefix,
          env,
          count,
          warn: (m: string) => ctx.warn(m),
        })
      pool = new AgentPool({
        size: count,
        create,
        ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
        // The docker transport bind-mounts ONE workspace into every agent, so
        // the install belongs to the workspace, not to each agent. A custom
        // transport whose agents have their own checkout should say so.
        prepareScope:
          options.prepareScope ?? (options.createAgent === undefined ? 'pool' : 'agent'),
        warn: (m) => ctx.warn(m),
      })
      const activePool = pool
      return {
        name: 'vx/agents',
        // Reported as remote so the scheduler gives these tasks their own pool
        // instead of local worker slots — the agents are not this machine's
        // CPUs. `where` then attributes each task to the agent that ran it.
        remote: true,
        capacity: count,
        accepts: acceptsTask,
        async execute(req: ExecuteRequest): Promise<ExecuteResult> {
          const lease = await activePool.acquire()
          const started = Bun.nanoseconds()
          try {
            const res = await lease.agent.exec({
              command: agentCommand(req, containerWorkspace),
              cwd: relativeCwd(ctx.workspaceRoot, req.cwd),
              // Only what the task DECLARED crosses: `exec.env.define`
              // literals plus the `cache.inputs.env` values already folded
              // into the key. The resolved child environment stays here — it
              // is this machine's PATH and HOME, and an agent has its own.
              env: agentEnv(req),
              onStdout: (c) => req.onStdout(c),
              onStderr: (c) => req.onStderr(c),
              ...(req.timeoutMs === undefined
                ? {}
                : { signal: AbortSignal.timeout(req.timeoutMs) }),
            })
            return {
              exitCode: res.exitCode,
              durationMs: Number(Bun.nanoseconds() - started) / 1e6,
              stdout: '',
              stderr: '',
              violations: [],
              where: lease.agent.id,
            } as unknown as ExecuteResult
          } finally {
            lease.release()
          }
        },
      }
    },
    async teardown(): Promise<void> {
      await pool?.close()
      pool = undefined
    },
  } as VxPlugin
}

interface BackendContext {
  image: string
  workspaceRoot: string
  containerWorkspace: string
  namePrefix: string
  env: Readonly<Record<string, string>>
  count: number
  warn: (m: string) => void
}

/** Pick the transport. Kept separate so each one's options stay its own. */
function backendFactory(
  options: AgentsPluginOptions,
  ctx: BackendContext,
): (index: number) => Promise<Agent> {
  switch (options.backend ?? 'docker') {
    case 'nomad': {
      const spec: NomadAgentOptions = {
        image: ctx.image,
        containerWorkspace: ctx.containerWorkspace,
        volumeSource: typeof options.volume === 'string' ? options.volume : ctx.workspaceRoot,
        cpu: typeof options.cpu === 'number' ? options.cpu : Number(options.cpu ?? 1000),
        memoryMb:
          typeof options.memory === 'number' ? options.memory : Number(options.memory ?? 2048),
        count: ctx.count,
        jobId: options.jobId ?? ctx.namePrefix,
        env: ctx.env,
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      }
      return nomadAgentFactory(spec, ctx.warn)
    }
    case 'kubernetes': {
      const spec: KubernetesAgentOptions = {
        image: ctx.image,
        containerWorkspace: ctx.containerWorkspace,
        volume:
          typeof options.volume === 'object' && options.volume !== null
            ? options.volume
            : { hostPath: { path: options.volume ?? ctx.workspaceRoot } },
        cpu: String(options.cpu ?? '1'),
        memory: String(options.memory ?? '2Gi'),
        namespace: options.namespace ?? 'default',
        namePrefix: ctx.namePrefix,
        env: ctx.env,
      }
      return kubernetesAgentFactory(spec, ctx.warn)
    }
    default:
      return (index: number) =>
        createDockerAgent(
          {
            image: ctx.image,
            workspaceRoot: typeof options.volume === 'string' ? options.volume : ctx.workspaceRoot,
            containerWorkspace: ctx.containerWorkspace,
            runArgs: dockerResourceArgs(options),
            env: ctx.env,
            namePrefix: ctx.namePrefix,
          },
          index,
        )
  }
}

/** `cpu`/`memory` map onto docker's own flags, so one config spells the same
 *  reservation on every backend. */
export function dockerResourceArgs(options: AgentsPluginOptions): string[] {
  const args = [...(options.runArgs ?? [])]
  if (options.cpu !== undefined) args.push('--cpus', String(options.cpu))
  if (options.memory !== undefined) args.push('--memory', String(options.memory))
  return args
}

/**
 * The command as the agent runs it: the same two `node_modules/.bin`
 * directories core puts on a LOCAL task's PATH, then the command itself.
 *
 * Without this a task resolving a package binary — `oxlint`, `astro`, `tsc` —
 * exits 127 on an agent while working locally, which is the worst kind of
 * placement bug: it only appears where you are not debugging. The project's
 * own bin wins, then the workspace root's, matching core exactly; the root
 * entry is where a monorepo's shared tooling actually lives.
 */
export function agentCommand(req: ExecuteRequest, containerWorkspace: string): string {
  const root = containerWorkspace.replace(/\/+$/, '')
  return `export PATH="$PWD/node_modules/.bin:${root}/node_modules/.bin:$PATH"; ` + fullCommand(req)
}

/** Forwarded args are appended shell-quoted, exactly as the local executor does. */
export function fullCommand(req: ExecuteRequest): string {
  if (req.forwardArgs.length === 0) return req.command
  const quoted = req.forwardArgs.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')
  return `${req.command} ${quoted}`
}

/** The task's own env, minus anything specific to THIS machine. */
export function agentEnv(req: ExecuteRequest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of req.inputs?.env ?? []) out[e.name] = e.value
  for (const [name, value] of Object.entries(req.envDefine)) out[name] = value
  return out
}

/** Workspace-relative POSIX cwd, which is what the agent's mount expects. */
export function relativeCwd(workspaceRoot: string, cwd: string): string {
  if (cwd === workspaceRoot) return '.'
  const rel = cwd.startsWith(workspaceRoot) ? cwd.slice(workspaceRoot.length) : cwd
  return (
    rel
      .replace(/^[/\\]+/, '')
      .split(/[/\\]/)
      .join('/') || '.'
  )
}
