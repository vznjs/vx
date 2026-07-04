// The distributed submission backend (distributed-execution-2026-07 §5):
// prepare → refusal gates → stable keys → dist:submit → self-register as
// an agent → render the relayed stream → materialize outputs. The
// submitter has the checkout, so it prepares the graph; the serve only
// schedules it.

import {
  FULL_CACHE_POLICY,
  LayeredCache,
  RemoteCache,
  UserError,
  captureGitContext,
  captureWorkspaceIdentity,
  cleanOutputs,
  createWireRenderer,
  defaultLogger,
  deriveStableKeys,
  findWorkspaceRoot,
  prepareRun,
  projectNode,
  projectOutcome,
  requestToOptions,
  resolveOutputView,
  run,
  type Logger,
  type OutcomeView,
  type PreparedRun,
  type RunBackend,
  type RunRequest,
  type RunResult,
  type ServerMessage,
  type TaskNode,
} from '@vzn/vx'
import {
  DIST_PROTOCOL_VERSION,
  type DistGraphNode,
  type DistSubmitMessage,
} from '../protocol-dist.js'
import { runAgentLoop, type AgentLoopHandle } from './agent-loop.js'
import { DEFAULT_AGENT_TIMEOUT_MS, SUBMITTER_LABEL } from './scheduler.js'
import { deriveSession, wireAgentCacheEnv } from './session.js'

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

const OK_STATUSES = new Set(['success', 'cache-hit', 'cache-hit-remote'])

export interface DistributedBackendOptions {
  /** http(s) origin of the serve hosting the session registry + store. */
  origin: string
  token?: string
  /** Advisory expected agent count (`VX_CLOUD_DISTRIBUTE=<n>`). */
  expectedAgents: number
  agentTimeoutMs?: number
  /**
   * `'explicit'` (the `VX_CLOUD_DISTRIBUTE` escape hatch, default): distribution
   * was hard-requested, so an unreachable serve is a hard error and the run
   * submits regardless of the instantaneous agent count (CI agents may join ms
   * after submit). `'ambient'` (a connected environment's `distribute`): fails
   * SAFE — an unreachable pool OR a pool with zero remote helpers degrades to a
   * normal local run, so leaving it on never blocks a solo run.
   */
  mode?: 'explicit' | 'ambient'
  /** Render sink override (tests); defaults to a normal defaultLogger. */
  sink?: Logger
  warn?: (line: string) => void
}

/**
 * The backend `cloud()` returns under `VX_CLOUD_DISTRIBUTE`. Refusal
 * gates (§5.3) fall back LOUDLY to a normal local run — distribution can
 * degrade, but an unreachable serve is a hard error (distribution was
 * explicitly requested; silently running locally would hide a broken
 * matrix forever).
 */
export function distributedBackend(opts: DistributedBackendOptions): RunBackend {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`))
  const mode = opts.mode ?? 'explicit'
  return {
    async run(request) {
      // `silent` skips the "distribution disabled" note — used for the ambient
      // no-helpers case, which is the fast, expected small path, not a warning.
      const fallback = async (reason: string, silent = false): Promise<RunResult> => {
        if (!silent) warn(`vx: distribution disabled: ${reason} — running locally`)
        const options = requestToOptions(request)
        if (opts.sink !== undefined) options.log = opts.sink
        const summary = await run(options)
        return { ok: summary.ok, outcomes: summary.outcomes.map(projectOutcome) }
      }

      if (request.forwardArgs !== undefined && request.forwardArgs.length > 0) {
        return await fallback('forwarded args (`-- …`) cannot be distributed')
      }
      const policy = request.cache ?? FULL_CACHE_POLICY
      if (!policy.remoteRead || !policy.remoteWrite) {
        return await fallback('the cache policy disables the remote layer (the artifact transport)')
      }

      if (mode === 'ambient') {
        // A connected pool that fails SAFE. Probe the pool's REMOTE capacity
        // BEFORE the (comparatively costly) graph prepare, so the common
        // solo/no-helpers case is a plain local run with no wasted work: pool
        // unreachable → warn + local; zero COMMIT-MATCHING remote helpers →
        // SILENT local (this machine's cores already saturate a one-process
        // run — a pool only helps with more same-commit machines).
        const root = await findWorkspaceRoot(request.cwd)
        const workspaceId = captureWorkspaceIdentity(root).id
        // Commit-scope the probe: a feature-branch dev whose pool holds only
        // main-pinned agents reads 0 helpers and stays a fast local run.
        const commit = captureGitContext(root).commitSha ?? undefined
        const capacity = await probeCapacity(
          opts.origin,
          opts.token,
          workspaceId,
          deriveSession(),
          commit,
        )
        if (capacity === undefined) {
          return await fallback(`pool at ${opts.origin} is unreachable`)
        }
        if (capacity.remoteAgents === 0) {
          return await fallback('the pool has no other agents at this commit', true)
        }
      } else if (!(await reachable(opts.origin))) {
        // Explicit distribution — an unreachable serve is infrastructure
        // misconfiguration, never a silent local run.
        throw new UserError(
          `VX_CLOUD_DISTRIBUTE is set but the serve at ${opts.origin} is unreachable`,
        )
      }

      const prepared = await prepareRun(requestToOptions(request), silentLogger)
      try {
        if (prepared.empty !== null) {
          return await fallback('no tasks matched the request')
        }
        if (prepared.gitFilesCache.worktreeDirty === true) {
          return await fallback(
            'the worktree is dirty — uncommitted changes cannot exist on agents',
          )
        }
        const git = captureGitContext(prepared.workspaceRoot, prepared.gitFilesCache.worktreeDirty)
        if (git.commitSha === null) {
          return await fallback('not a git checkout with a commit')
        }
        for (const node of prepared.nodes.values()) {
          if (node.config.exec?.persistent !== undefined) {
            return await fallback(`task ${node.id} is persistent (a dev server cannot distribute)`)
          }
        }

        // The SAME derivation remote-prefetch and the local short-circuit
        // share — the submitted stable hash IS the key an executing agent
        // saves under (§6.3), which is what makes the serve's stat-prune
        // sound.
        const stable = await deriveStableKeys({
          nodes: prepared.nodes,
          cache: prepared.cache,
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          forwardArgs: request.forwardArgs,
          nestedDirsByProject: prepared.nestedDirsByProject,
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
        })
        const stableById = new Map(stable.map((s) => [s.node.id, s.hash]))
        const nodes: DistGraphNode[] = [...prepared.nodes.values()].map((n) => ({
          id: n.id,
          deps: [...n.deps],
          view: projectNode(n),
          ...(stableById.has(n.id) ? { stableHash: stableById.get(n.id)! } : {}),
        }))

        const identity = captureWorkspaceIdentity(prepared.workspaceRoot)
        const session = deriveSession()
        // A session multiplexes concurrent submissions on this id; the self-
        // agent presents it as `ownerSubmissionId` so only THIS run may use it.
        const submissionId = Bun.randomUUIDv7()
        const submit: DistSubmitMessage = {
          t: 'dist:submit',
          protocol: DIST_PROTOCOL_VERSION,
          session,
          workspaceId: identity.id,
          submissionId,
          commitSha: git.commitSha,
          expectedAgents: opts.expectedAgents,
          agentTimeoutMs:
            opts.agentTimeoutMs ??
            parsePositiveInt(process.env['VX_CLOUD_AGENT_TIMEOUT_MS']) ??
            DEFAULT_AGENT_TIMEOUT_MS,
          request,
          nodes,
        }

        // Wire the self-agent's scoped runs at the serve's own artifact store +
        // flag the process as an agent (shared verbatim with the `agent` verb).
        wireAgentCacheEnv(opts.origin, opts.token)

        const selfExecuted = new Set<string>()
        const result = await submitAndRender({
          origin: opts.origin,
          token: opts.token,
          submit,
          sink: opts.sink,
          selfAgent: {
            workspaceId: identity.id,
            session,
            commitSha: git.commitSha,
            capacity: request.concurrency ?? Math.max(1, navigator.hardwareConcurrency),
            checkoutRoot: prepared.workspaceRoot,
            frozen: request.frozen,
            cache: request.cache,
            onAssigned: (taskId) => selfExecuted.add(taskId),
          },
        })

        await materializeOutputs({
          prepared,
          origin: opts.origin,
          token: opts.token,
          outcomes: result.outcomes,
          selfExecuted,
        })
        return result
      } finally {
        prepared.cache.close()
      }
    },
  }
}

interface SelfAgentArgs {
  workspaceId: string
  session: string
  commitSha: string
  capacity: number
  checkoutRoot: string
  frozen?: boolean | undefined
  cache?: RunRequest['cache'] | undefined
  onAssigned: (taskId: string) => void
}

/**
 * Two independent WS clients (§5.2): the submission socket (submit +
 * event stream → renderer) and an agent socket running the identical
 * loop the `agent` verb runs. They never interleave on one socket.
 */
function submitAndRender(args: {
  origin: string
  token: string | undefined
  submit: DistSubmitMessage
  sink: Logger | undefined
  selfAgent: SelfAgentArgs
}): Promise<RunResult> {
  const request = args.submit.request
  const renderer =
    args.sink ??
    defaultLogger(
      undefined,
      resolveOutputView({
        ...(request.flow !== undefined ? { flow: request.flow } : {}),
        ...(request.outputLogs !== undefined ? { outputLogs: request.outputLogs } : {}),
      }),
    )
  const render = createWireRenderer(renderer)
  const wsUrl = args.origin.replace(/^http/, 'ws')

  return new Promise<RunResult>((resolve, reject) => {
    const ws =
      args.token !== undefined
        ? new WebSocket(wsUrl, { headers: { authorization: `Bearer ${args.token}` } })
        : new WebSocket(wsUrl)
    let result: RunResult | null = null
    let failure: Error | null = null
    let agentLoop: AgentLoopHandle | null = null
    ws.onopen = () => {
      ws.send(JSON.stringify(args.submit))
      // Self-register as an agent: there is always at least one agent
      // (this process), so the zero-agent deadlock cannot occur.
      agentLoop = runAgentLoop({
        origin: args.origin,
        ...(args.token !== undefined ? { token: args.token } : {}),
        workspaceId: args.selfAgent.workspaceId,
        session: args.selfAgent.session,
        commitSha: args.selfAgent.commitSha,
        capacity: args.selfAgent.capacity,
        checkoutRoot: args.selfAgent.checkoutRoot,
        labels: [SUBMITTER_LABEL],
        // Own this submission: the self-agent is eligible only for its own run,
        // so a same-commit peer submission can't conscript this machine.
        ownerSubmissionId: args.submit.submissionId,
        ...(args.selfAgent.frozen !== undefined ? { frozen: args.selfAgent.frozen } : {}),
        ...(args.selfAgent.cache !== undefined ? { cache: args.selfAgent.cache } : {}),
        onAssigned: args.selfAgent.onAssigned,
      })
    }
    ws.onmessage = (e) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(e.data)) as ServerMessage
      } catch {
        return
      }
      if (message.t === 'event') render(message.event)
      else if (message.t === 'result') {
        result = message.result
        ws.close()
      } else if (message.t === 'error') {
        failure = new UserError(message.message)
        ws.close()
      }
    }
    ws.onerror = () => {
      failure ??= new Error('vx-cloud serve: connection error')
    }
    ws.onclose = () => {
      agentLoop?.stop()
      if (result) resolve(result)
      else reject(failure ?? new Error('vx-cloud serve: closed without a result'))
    }
  })
}

/**
 * Output materialization (§6.6): a local `vx run build` leaves `dist/`
 * populated, so a distributed one must too. TARGETED restores — for every
 * terminal-success cacheable task with declared outputs that this process
 * did not execute itself: `layered.get(hash)` (ingesting into the local
 * cache as a side effect) → `cleanOutputs` → `restoreOutputs`, in topo
 * order. Never a naive re-run (that would re-execute uncacheable tasks).
 */
async function materializeOutputs(args: {
  prepared: PreparedRun
  origin: string
  token: string | undefined
  outcomes: readonly OutcomeView[]
  selfExecuted: ReadonlySet<string>
}): Promise<void> {
  const { prepared } = args
  const byId = new Map(args.outcomes.map((o) => [o.taskId, o]))
  // prepareRun ran BEFORE the env pointed at the serve, so prepared.cache
  // may be local-only; build the layered view explicitly when needed.
  const layered =
    prepared.cache instanceof LayeredCache
      ? prepared.cache
      : new LayeredCache(prepared.localCache, remoteFor(args.origin, args.token), {})

  for (const id of topoOrder(prepared.nodes)) {
    const node = prepared.nodes.get(id)!
    if (node.config.exec === undefined) continue
    if (args.selfExecuted.has(id)) continue
    const outcome = byId.get(id)
    if (outcome === undefined || outcome.hash === undefined) continue
    if (!OK_STATUSES.has(outcome.status)) continue
    const outputs = node.config.cache?.outputs
    const files = outputs?.files ?? []
    const workspaceFiles = outputs?.workspaceFiles ?? []
    if (files.length === 0 && workspaceFiles.length === 0) continue
    const entry = await layered.get(outcome.hash, {
      taskId: id,
      command: node.config.exec.command,
    })
    if (entry === null) continue
    await cleanOutputs({
      projectDir: node.projectDir,
      outputs: [...files],
      nestedProjectDirs: prepared.nestedDirsByProject.get(node.projectName) ?? [],
    })
    await layered.restoreOutputs(outcome.hash, node.projectDir, prepared.workspaceRoot)
  }
}

function remoteFor(origin: string, token: string | undefined): RemoteCache {
  const config: ConstructorParameters<typeof RemoteCache>[0] = {
    baseUrl: origin,
    token: token ?? '-',
  }
  const signatureKey = process.env['VX_REMOTE_CACHE_SIGNATURE_KEY']
  if (signatureKey) config.signatureKey = signatureKey
  return new RemoteCache(config)
}

function topoOrder(nodes: Map<string, TaskNode>): string[] {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes.values()) {
    indegree.set(node.id, node.deps.length)
    for (const dep of node.deps) {
      const list = dependents.get(dep)
      if (list) list.push(node.id)
      else dependents.set(dep, [node.id])
    }
  }
  const queue: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id)
  const out: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const d of dependents.get(id) ?? []) {
      const left = (indegree.get(d) ?? 0) - 1
      indegree.set(d, left)
      if (left === 0) queue.push(d)
    }
  }
  return out
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

async function reachable(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Read a pool's REMOTE (helper) agent count for the ambient capacity gate.
 * Network error / non-OK → `undefined` (treated as "unreachable"); otherwise
 * the counts the serve's `/v1/agents` GET reports for this {ws, session}.
 */
async function probeCapacity(
  origin: string,
  token: string | undefined,
  workspaceId: string,
  session: string,
  commit?: string,
): Promise<{ remoteAgents: number } | undefined> {
  try {
    const url =
      `${origin.replace(/\/$/, '')}/v1/agents` +
      `?ws=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(session)}` +
      (commit !== undefined ? `&commit=${encodeURIComponent(commit)}` : '')
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1000),
      ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { remoteAgents?: unknown }
    return { remoteAgents: typeof body.remoteAgents === 'number' ? body.remoteAgents : 0 }
  } catch {
    return undefined
  }
}
