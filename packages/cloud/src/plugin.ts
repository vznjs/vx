// The first-party `cloud()` VxPlugin. Contributes the run-level capabilities
// against core's plugin interface:
//
//   backend   — distribute the run across a connected agent pool
//               (VX_CLOUD_DISTRIBUTE / an ambient `--distribute` environment).
//               Run delegation was removed (platform §12 P3), so a plain
//               connection never moves execution — this declines and core's
//               localBackend runs the graph in-process.
//   cache     — wrap the local Cache in a `LayeredCache` over the vx-native
//               `/v1/cache` wire the connected serve hosts. Declines
//               (undefined) when unconfigured.
//   telemetry — push the canonical RunSummaryRecord to the cloud's /v1/ingest
//               endpoint at run end. Observe-only (it cannot change a run) and
//               never-fail. Declines when unconfigured. This is the data path:
//               the cloud service ingests these summaries into its OWN store
//               and serves the dashboard from there — it no longer reads a
//               developer's private cache.db. See
//               docs/design/observability-architecture-2026-06.md.
//
// Every option falls back to an env var, so `cloud()` with no args is the
// zero-config form (declines the backend + cache + telemetry rungs until a
// connection / VX_CLOUD_DISTRIBUTE is configured — a plain `vx run` pays nothing).

import {
  LayeredCache,
  parseDecimalInt,
  resolveCacheScope,
  UserError,
  type CacheContext,
  type CachePolicy,
  type CacheLayer,
  type RunSummaryRecord,
  type TaskTelemetry,
  type TelemetryContext,
  type TelemetryRecord,
  type TelemetrySink,
  type VxPlugin,
} from '@vzn/vx'
import type { TaskIngestRecord } from './db/analytics.js'
import { activeEnvironment } from './environments.js'
import { NativeCacheClient } from './native-cache.js'
import { githubCheckCandidate, postGithubCheck, resolveGithubCheckTarget } from './github-check.js'
import {
  appendGithubSummary,
  type GithubSummaryOptions,
  type GithubTriageVerdict,
} from './github-summary.js'
import { TaskLogBuffer } from './task-log-capture.js'

/** A resolved serve target for the ingest sink's POSTs. */
interface SinkConnection {
  baseUrl: string
  token?: string
}

// NB: the heavy service machinery (backend resolution → serve / dev hub) is
// loaded LAZILY inside `backend()` via a dynamic import, so merely DECLARING
// `cloud()` in a workspace config (the common case) keeps the run's config-eval
// light — it imports this module + core only, not the whole service layer.

export interface CloudPluginOptions {
  /**
   * The ONE connection: the origin of a `vx-cloud serve`. This single URL
   * drives ALL THREE capabilities — analytics ingest (`/v1/ingest`), the
   * remote cache (`/v1/cache`), and distributed execution — so a
   * connected cloud needs no separate cache/ingest/service config. Falls back
   * to `VX_CLOUD_URL`; with none set, the ACTIVE connected environment
   * (`vx-cloud connect`) is used. No environment → decline.
   */
  url?: string
  /**
   * The bearer token for the connection. **Trust tier follows the token**:
   * this is the TRUSTED token (reads/writes the trusted cache scope). Falls
   * back to `VX_CLOUD_TOKEN`.
   */
  token?: string
  /**
   * The UNTRUSTED (fork-PR) token. Falls back to `VX_CLOUD_PR_TOKEN`. Present
   * this (instead of `token`) from a fork-PR CI job: it reads the trusted
   * cache to stay fast but writes only the untrusted scope, so it can't poison
   * a trusted build. Which token you present IS the tier — the server derives
   * it; there is no separate trust flag. Safe to expose.
   */
  prToken?: string
  /**
   * Distribute runs across `vx-cloud agent` machines (advisory expected
   * agent count). Falls back to `VX_CLOUD_DISTRIBUTE`. When set, the
   * backend capability returns the distributed submitter; a serve must be
   * configured or connected (hard error otherwise — distribution is an
   * explicit opt-in, unlike ambient delegation). Unset → zero cost.
   */
  distribute?: number
  /**
   * Capture per-task log tails and ship them to the connection so the
   * dashboard can show a task's output (default true when a cloud is
   * connected). Falls back to `VX_CLOUD_LOGS` (`0`/`false` disables). Off →
   * the sink's `wants` stays empty, so `task:stdout` events are never even
   * projected — a plain run pays nothing.
   */
  logs?: boolean
}

/** One resolved connection to a `vx-cloud serve` — drives all three rungs. */
interface CloudConnection {
  /** Base origin (trailing slash trimmed). */
  url: string
  /** Trusted bearer (reads/writes the trusted cache scope). */
  token?: string
  /** Untrusted (fork-PR) bearer (reads trusted, writes untrusted). */
  prToken?: string
  /** Where it came from: an explicit URL is trusted as-is; a discovered one
   *  (the connected environment) is capability-probed before the cache uses it. */
  source: 'explicit' | 'environment'
}

const firstEnv = (...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = process.env[k]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}
const trimUrl = (u: string): string => u.replace(/\/+$/, '')

/**
 * Resolve the ONE cloud connection every capability shares. Ladder:
 *   1. an explicit URL — `opts.url` / `VX_CLOUD_URL` (+ the pre-consolidation
 *      `VX_SERVICE_URL` / `VX_CLOUD_INGEST_URL` aliases), paired with
 *      `VX_CLOUD_TOKEN` / `VX_CLOUD_PR_TOKEN`;
 *   2. the ACTIVE connected environment (`vx-cloud connect`);
 *   3. decline.
 * There is deliberately NO local-serve auto-detect: `vx-cloud connect` is the
 * one wiring story (a running serve never captures runs by mere existence).
 * Trust is NOT resolved here — the client just carries whichever token(s) it
 * has; the serve derives the tier from the presented bearer.
 */
function resolveConnection(opts: CloudPluginOptions): CloudConnection | undefined {
  const explicitUrl =
    opts.url ??
    firstEnv('VX_CLOUD_URL', 'VX_SERVICE_URL', 'VX_CLOUD_INGEST_URL', 'VX_CLOUD_INSIGHTS_URL')
  if (explicitUrl !== undefined) {
    const token = opts.token ?? firstEnv('VX_CLOUD_TOKEN', 'VX_CLOUD_INGEST_TOKEN')
    const prToken = opts.prToken ?? firstEnv('VX_CLOUD_PR_TOKEN')
    return {
      url: trimUrl(explicitUrl),
      source: 'explicit',
      ...(token !== undefined ? { token } : {}),
      ...(prToken !== undefined ? { prToken } : {}),
    }
  }
  const env = activeEnvironment()
  if (env !== undefined) {
    return {
      url: trimUrl(env.url),
      source: 'environment',
      ...(env.token !== undefined ? { token: env.token } : {}),
      ...(env.prToken !== undefined ? { prToken: env.prToken } : {}),
    }
  }
  return undefined
}

/**
 * The first-party `@vzn/vx-cloud` plugin. Declared in `vx.workspace.ts` via
 * `defineWorkspace({ plugins: [cloud()] })`. Contributes backend / cache /
 * telemetry — all fed by ONE connection (`resolveConnection`); each capability
 * is independent and zero-config via env vars.
 */
export function cloud(opts: CloudPluginOptions = {}): VxPlugin {
  return {
    name: 'vzn/cloud',

    setup() {
      assertWellFormedUrl(
        opts.url ??
          firstEnv(
            'VX_CLOUD_URL',
            'VX_SERVICE_URL',
            'VX_CLOUD_INGEST_URL',
            'VX_CLOUD_INSIGHTS_URL',
          ),
        'url',
      )
    },

    async backend(ctx) {
      // Distribution rung (VX_CLOUD_DISTRIBUTE / cloud({ distribute })):
      // explicit opt-in. Unset → this rung is ONE env read (the zero-overhead
      // decline invariant, pinned by tests).
      const distribute = distributeOf(opts)
      if (distribute !== undefined) {
        const conn = resolveConnection(opts)
        if (conn === undefined) {
          throw new UserError(
            'VX_CLOUD_DISTRIBUTE is set but no vx-cloud serve is configured — ' +
              'set VX_CLOUD_URL or `vx-cloud connect` an environment',
          )
        }
        const token = conn.token ?? conn.prToken
        const { distributedBackend } = await import('./dist/submit.js')
        return distributedBackend({
          origin: conn.url,
          ...(token !== undefined ? { token } : {}),
          expectedAgents: distribute,
          warn: (line) => ctx.warn(line),
        })
      }
      // One env-file read for the ambient-distribute rung (memoized; only
      // happens when cloud() is declared). No environment connected → decline →
      // core's localBackend, so a plain `vx run` keeps its zero-overhead fast path.
      const env = activeEnvironment()

      // Ambient DISTRIBUTION: an environment connected with `--distribute`
      // fans a run out to that serve's POOL of agents — but FAILS SAFE. Unlike
      // delegation it doesn't move a whole run to one server; it submits the
      // graph to a pool and `distributedBackend({ mode: 'ambient' })` probes
      // capacity first, degrading to a normal LOCAL run when the pool is
      // unreachable or holds no other agents. That safety is what makes it OK
      // to leave on: a solo `vx run` stays fast; add helper agents and the same
      // command fans out. See docs/design/universal-agents-2026-07.md.
      if (env?.distribute !== undefined && env.distribute !== false) {
        const conn = resolveConnection(opts)
        if (conn !== undefined) {
          const token = conn.token ?? conn.prToken
          const { distributedBackend } = await import('./dist/submit.js')
          return distributedBackend({
            origin: conn.url,
            ...(token !== undefined ? { token } : {}),
            mode: 'ambient',
            expectedAgents: typeof env.distribute === 'number' ? env.distribute : 0,
            warn: (line) => ctx.warn(line),
          })
        }
        // No resolvable connection → just run locally (never an error): an
        // ambient pool is a convenience, not a requirement.
      }

      // Run delegation was REMOVED (platform §12 P3) — the platform has no
      // checkout. A plain connection never moves execution; distribution
      // (above) is the only way a run leaves this machine. Decline → core's
      // localBackend.
      return undefined
    },

    cache(ctx): CacheLayer | undefined | Promise<CacheLayer | undefined> {
      // The remote cache is INTERNAL to the connection: the same `vx-cloud`
      // you connect to hosts `/v1/cache`, so no separate cache URL/token.
      // Which token you present decides the trust tier (server-enforced) — the
      // trusted token, else the fork-PR token. A connection with no token
      // (a local open serve) declines: the local cache already has the bytes.
      const conn = resolveConnection(opts)
      if (conn === undefined) return undefined
      const token = conn.token ?? conn.prToken
      if (token === undefined) return undefined
      // An explicitly-configured URL is trusted as-is; a DISCOVERED serve
      // (active environment) is capability-probed (`/v1/meta cacheWire >= 1`,
      // memoized) so connecting for the dashboard alone doesn't wrongly route
      // the cache at a serve that doesn't host it.
      if (conn.source === 'explicit') {
        return buildCloudCache(ctx, conn.url, token, ctx.policy)
      }
      return (async () => {
        if (!(await serveAdvertisesCacheWire(conn.url))) return undefined
        return buildCloudCache(ctx, conn.url, token, ctx.policy)
      })()
    },

    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      // Agent sentinel: a distribution agent's per-assignment scoped runs
      // must not spam the ingest store with 1-task invocations. Other
      // telemetry plugins (e.g. otel()) are unaffected by design.
      if (process.env['VX_CLOUD_AGENT'] === '1') return undefined
      // Push the run summary to the connection's `/v1/ingest` — the SAME
      // connection the cache and distribution use. No connection → decline,
      // so a plain `vx run` is unaffected.
      const conn = resolveConnection(opts)
      // Also activate (with no connection) to write the GitHub Actions job
      // summary — a CI run that declares cloud() gets a per-task result table
      // on the job page whether or not a serve is attached — and/or to post a
      // real CHECK RUN on the commit when the step was handed a GITHUB_TOKEN
      // (that hand-off IS the opt-in; the token is never ambient in Actions).
      // Nothing → decline, so a plain local `vx run` is still untouched.
      // `?? prToken`, like every other rung (both backend paths and the cache).
      // A FORK-PR job holds ONLY the PR token — that is the point, since repo
      // secrets are not exposed to forks — so reading `token` alone sent the
      // run summary with NO Authorization header at all, guaranteeing a 401:
      // fork-PR runs never reached the dashboard and never got triage verdicts
      // on their check. Which token is presented IS the tier, and the server
      // decides what an untrusted bearer may do; sending none removes that
      // decision and makes the answer always "no".
      const ingestToken = conn?.token ?? conn?.prToken
      const ghaSummary = firstEnv('GITHUB_STEP_SUMMARY')
      const ghaCheck = githubCheckCandidate(process.env)
      if (conn === undefined && ghaSummary === undefined && !ghaCheck) return undefined
      return new CloudIngestSink({
        ...(conn !== undefined
          ? {
              connection: {
                baseUrl: conn.url,
                ...(ingestToken !== undefined ? { token: ingestToken } : {}),
              },
            }
          : {}),
        warn: (m) => ctx.warn(m),
        logsEnabled: logsEnabled(opts),
        ...(ghaSummary !== undefined ? { githubSummaryPath: ghaSummary } : {}),
        githubCheck: ghaCheck,
      })
    },
  }
}

/** Per-task log capture is on by default when connected; `cloud({ logs: false })`
 *  or `VX_CLOUD_LOGS=0`/`false` turns it off. */
function logsEnabled(opts: CloudPluginOptions): boolean {
  if (opts.logs !== undefined) return opts.logs
  const raw = process.env['VX_CLOUD_LOGS']
  return raw !== '0' && raw !== 'false'
}

function distributeOf(opts: CloudPluginOptions): number | undefined {
  if (opts.distribute !== undefined) {
    return Number.isInteger(opts.distribute) && opts.distribute > 0 ? opts.distribute : undefined
  }
  const raw = process.env['VX_CLOUD_DISTRIBUTE']
  if (raw === undefined || raw === '') return undefined
  // `parseDecimalInt`, not `Number`: this function already refuses `abc` and
  // `-1`, so accepting `0x10` as 16 and `1e3` as 1000 taught the reader it
  // validates when it half did.
  const n = parseDecimalInt(raw)
  if (n === null || n < 1) {
    throw new UserError(`invalid VX_CLOUD_DISTRIBUTE: ${raw} (expected a positive agent count)`)
  }
  return n
}

/**
 * The native-wire LayeredCache construction: a `NativeCacheClient` speaking
 * the serve's `/v1/cache` endpoints. The trust tier is carried by the
 * `token` (server-enforced) — the client just presents it.
 */
function buildCloudCache(
  ctx: CacheContext,
  baseUrl: string,
  token: string,
  policy: CachePolicy,
): CacheLayer {
  const config: ConstructorParameters<typeof NativeCacheClient>[0] = { baseUrl, token }
  // Untrusted per-PR isolation: one fork PR's untrusted writes/reads are
  // partitioned from another's on the serve.
  const cacheScope = resolveCacheScope(process.env)
  if (cacheScope !== undefined) config.cacheScope = cacheScope

  ctx.warn(`cloud cache: ${baseUrl}`)
  return new LayeredCache(ctx.localCache, new NativeCacheClient(config), {
    onRemoteError: (err) => ctx.warn(`[vx] cloud cache: ${err.message}`),
    policy,
  })
}

// The /v1/meta capability probe, memoized per origin for the process — the
// cache capability is consulted once per run, so one short-bounded GET is
// the whole cost, and only when a connected environment exists at all.
const metaProbeMemo = new Map<string, Promise<boolean>>()

function serveAdvertisesCacheWire(url: string): Promise<boolean> {
  const origin = url.replace(/\/+$/, '')
  const existing = metaProbeMemo.get(origin)
  if (existing) return existing
  const probe = (async () => {
    // Clearable timer, not AbortSignal.timeout (same not-unref'd-timer
    // reason as the ingest sink).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(`${origin}/v1/meta`, { signal: controller.signal })
      if (!res.ok) return false
      const meta = (await res.json()) as { cacheWire?: unknown }
      return typeof meta.cacheWire === 'number' && meta.cacheWire >= 1
    } catch {
      // unreachable serve → the cache rung declines; never fails a run
      return false
    } finally {
      clearTimeout(timer)
    }
  })()
  metaProbeMemo.set(origin, probe)
  return probe
}

function assertWellFormedUrl(value: string | undefined, field: string): void {
  if (value === undefined || value === '') return
  try {
    new URL(value)
  } catch {
    throw new UserError(`cloud(): ${field} is not a valid URL: ${value}`)
  }
}

/** Per-run budget for serialized fingerprint file maps in one summary POST
 *  (verify-cross-machine §2). Enforced cloud-side so core stays stateless. */
const FP_RUN_BUDGET_BYTES = 4 * 1024 * 1024

/**
 * Bound the fingerprint payload of a summary: walk tasks in order, spending
 * the budget on each task's serialized `files`; past it, later tasks ship
 * tree-only (`truncated: true` — divergence DETECTION never needs the map).
 * An under-budget summary is returned as the SAME object, byte-identical on
 * the wire.
 */
export function capFingerprintPayload(summary: RunSummaryRecord): RunSummaryRecord {
  let budget = FP_RUN_BUDGET_BYTES
  let trimmed = false
  const tasks = summary.tasks.map((t) => {
    const fp = t.outputFp
    if (fp?.files === undefined) return t
    const size = JSON.stringify(fp.files).length
    if (size <= budget) {
      budget -= size
      return t
    }
    trimmed = true
    return { ...t, outputFp: { tree: fp.tree, fileCount: fp.fileCount, truncated: true } }
  })
  return trimmed ? { ...summary, tasks } : summary
}

/**
 * Pushes the canonical RunSummaryRecord to the cloud ingest endpoint. Summary
 * mode: one JSON POST per run, at run end (the smallest contract; the cloud
 * persists it into its own analytics store). Observe-only + never-fail: the
 * POST is time-bounded, errors are swallowed, and the upload is idempotent —
 * a down endpoint can never slow or fail a run.
 */
class CloudIngestSink implements TelemetrySink {
  readonly name = 'vzn/cloud'
  /**
   * Summary always; `task.log` + `task.end` ONLY when log capture is enabled.
   * The source checks this before projecting a `task:stdout` event, so an
   * empty `wants` means a plain run pays nothing on the chunk path.
   */
  readonly wants: ReadonlyArray<TelemetryRecord['kind']>
  private summary: RunSummaryRecord | undefined
  private uploaded = false
  /** Messages already surfaced this run — see `send` for why. */
  private readonly warned = new Set<string>()
  private readonly logs?: TaskLogBuffer
  private readonly connection?: SinkConnection
  private readonly warn: (message: string) => void
  private readonly githubSummaryPath?: string
  private readonly githubCheck: boolean
  /** Per-task incremental reporting is on whenever there's a connection: each
   *  EXECUTED task's result (+ its log tail) ships the moment it finishes, so
   *  the run's detail fills in live. The end-of-run summary is the backstop. */
  private readonly incremental: boolean
  /** Captured from `run.start`: the canonical run start (matches the summary's
   *  `startedAt`, so incremental task rows dedup against the batch) + the
   *  client workspace id to route to. */
  private runStart?: { startedAt: number; workspaceId: string; workspaceName?: string }

  constructor(opts: {
    /** A serve to POST to. Absent → the sink only writes the GitHub summary. */
    connection?: SinkConnection
    warn: (message: string) => void
    logsEnabled?: boolean
    /** `$GITHUB_STEP_SUMMARY` — append the run's result table when in CI. */
    githubSummaryPath?: string
    /** Post a GitHub check run on the commit (GITHUB_TOKEN present in Actions). */
    githubCheck?: boolean
  }) {
    if (opts.connection !== undefined) this.connection = opts.connection
    this.warn = opts.warn
    if (opts.githubSummaryPath !== undefined) this.githubSummaryPath = opts.githubSummaryPath
    this.githubCheck = opts.githubCheck === true
    this.incremental = opts.connection !== undefined
    // With a connection, project run.start (the run's canonical start) +
    // task.end (per-task results). Log capture only makes sense with a serve to
    // ship tails to; when on, also project task.log chunks. No connection →
    // empty `wants`, so a plain run pays nothing on the chunk path.
    if (this.incremental) {
      const wants: TelemetryRecord['kind'][] = ['run.start', 'task.end']
      if (opts.logsEnabled === true) {
        this.logs = new TaskLogBuffer()
        wants.push('task.log')
      }
      this.wants = wants
    } else {
      this.wants = []
    }
  }

  onRecord(record: TelemetryRecord): void {
    if (record.kind === 'run.start') {
      this.runStart = {
        startedAt: record.startedAt,
        workspaceId: record.run.workspaceId,
        ...(record.run.workspaceName !== undefined
          ? { workspaceName: record.run.workspaceName }
          : {}),
      }
      return
    }
    if (record.kind === 'task.log') {
      this.logs?.append(record.taskId, record.chunk)
      return
    }
    if (record.kind === 'task.end') {
      // Finalize the task's log tail first (retain/evict), then take it for the
      // incremental push. A hit/skipped task retains nothing → no tail to send.
      this.logs?.finish(record.taskId, record.status, record.cacheSource, record.hash)
      // Report EXECUTED tasks incrementally (misses that ran to a real
      // verdict). Cache hits + the full picture land in the end-of-run batch —
      // this keeps the per-task push rate bounded (executed tasks are spread
      // over wall time) and focused on "watch it run".
      if (
        this.incremental &&
        this.runStart !== undefined &&
        record.cacheSource === 'miss' &&
        (record.status === 'success' || record.status === 'failed')
      ) {
        this.sendTaskIncremental(record)
      }
    }
  }

  /** Fire-and-forget one task's result + log tail to `/v1/ingest/task`. */
  private sendTaskIncremental(record: Extract<TelemetryRecord, { kind: 'task.end' }>): void {
    const rs = this.runStart!
    const tail = this.logs?.takeEntry(record.taskId)
    const rec: TaskIngestRecord = {
      v: 1,
      runId: record.runId,
      workspaceId: rs.workspaceId,
      ...(rs.workspaceName !== undefined ? { workspaceName: rs.workspaceName } : {}),
      runStartedAt: rs.startedAt,
      // The task.end record is a superset of TaskTelemetry — pass it as the
      // task; the server reads only the TaskTelemetry fields.
      task: record as unknown as TaskTelemetry,
      ...(tail !== undefined
        ? {
            log: {
              content: tail.content,
              charsFull: tail.charsFull,
              truncatedHeadChars: tail.truncatedHeadChars,
            },
          }
        : {}),
    }
    void this.send('/v1/ingest/task', JSON.stringify(rec), 'cloud task')
  }

  onRunSummary(summary: RunSummaryRecord): void {
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.uploaded || this.summary === undefined) return
    this.uploaded = true
    if (this.connection !== undefined) {
      // Summary first (so the run row normally exists when logs land — the
      // store tolerates either order), then the drained log bundle if any.
      await this.send(
        '/v1/ingest',
        JSON.stringify(capFingerprintPayload(this.summary)),
        'cloud ingest',
      )
      if (this.logs !== undefined) {
        const runId = this.summary.run.runId
        const workspaceId = (this.summary.run as { workspaceId?: string }).workspaceId
        if (workspaceId !== undefined) {
          const bundle = this.logs.drain(runId, workspaceId)
          if (bundle.tasks.length > 0) {
            await this.send('/v1/ingest/logs', JSON.stringify(bundle), 'cloud logs')
          }
        }
      }
    }
    // Deep link into the connected dashboard (DX-2): a red check is ONE click
    // from the run's logs + artifacts. Only when a connection resolved — the
    // GHA-summary-only mode has no dashboard to point at.
    const ghOpts: GithubSummaryOptions =
      this.connection !== undefined
        ? {
            dashboardUrl: `${this.connection.baseUrl}/#/runs/${encodeURIComponent(this.summary.run.runId)}`,
          }
        : {}
    // Triage verdicts on the PR page (dev-scenarios S3 follow-up): a red run
    // with a connection asks the platform "is this failure mine?" and marks
    // each failed row flaky / already-broken / new. AFTER the ingest above so
    // the run's rows exist server-side; never-fail — any error just leaves
    // the plain rows.
    if (
      this.summary.failedCount > 0 &&
      (this.githubSummaryPath !== undefined || this.githubCheck)
    ) {
      const triage = await this.fetchTriage(this.summary.run.runId)
      if (triage !== undefined) ghOpts.triage = triage
    }
    if (this.githubSummaryPath !== undefined) {
      await appendGithubSummary(this.githubSummaryPath, this.summary, this.warn, ghOpts)
    }
    if (this.githubCheck) {
      // Resolved at flush (reads the event payload for the PR head SHA);
      // any missing ingredient resolves to undefined and skips silently.
      const target = await resolveGithubCheckTarget(process.env, this.summary.run.command)
      if (target !== undefined) await postGithubCheck(target, this.summary, this.warn, ghOpts)
    }
  }

  /** GET `/v1/triage/:runId` from the connection — the failed tasks'
   *  "is this failure mine?" verdicts. undefined on ANY problem (no
   *  connection, non-200, malformed, timeout): the check renders plain. */
  private async fetchTriage(runId: string): Promise<Map<string, GithubTriageVerdict> | undefined> {
    if (this.connection === undefined) return undefined
    try {
      const headers: Record<string, string> = {}
      if (this.connection.token) headers['authorization'] = `Bearer ${this.connection.token}`
      // Clearable timer, same reason as post(): AbortSignal.timeout's internal
      // timer is not unref'd and would hold the CLI open after the fetch.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetch(
          `${this.connection.baseUrl}/v1/triage/${encodeURIComponent(runId)}`,
          { headers, signal: controller.signal },
        )
        if (!res.ok) return undefined
        const body = (await res.json()) as {
          rows?: Array<{ taskId: string } & GithubTriageVerdict>
        }
        if (!Array.isArray(body.rows) || body.rows.length === 0) return undefined
        return new Map(body.rows.map((r) => [r.taskId, r]))
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return undefined
    }
  }

  /** POST a body to a serve path; every failure swallowed + warned (telemetry
   *  never fails a run).
   *
   *  Deduped by MESSAGE, because the per-task path fires once per executed
   *  task: against a platform that refuses every request, a 500-task run would
   *  otherwise print 500 identical lines and bury the run's real output. A
   *  genuinely different failure (another status, another surface) still gets
   *  its own line — the set is bounded by the number of distinct
   *  (label, status) pairs, which is a handful. */
  private async send(pathname: string, body: string, label: string): Promise<void> {
    try {
      await this.post(`${this.connection!.baseUrl}${pathname}`, body)
    } catch (err) {
      const message = `[vx] ${label}: ${err instanceof Error ? err.message : String(err)}`
      if (this.warned.has(message)) return
      this.warned.add(message)
      this.warn(message)
    }
  }

  private async post(url: string, body: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const token = this.connection?.token
    if (token) headers['authorization'] = `Bearer ${token}`
    // A clearable timer (NOT AbortSignal.timeout, whose internal timer is not
    // unref'd and would keep the CLI process alive for the full timeout after
    // the POST already resolved — a 5s "hang" at the end of every run).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      // A non-2xx does NOT reject `fetch`, so without this the run's telemetry
      // is discarded in total silence: the POST "succeeds", `send`'s catch
      // never fires, and the dashboard stays empty forever with no signal to
      // the user. That is the shape `vx-cloud connect` was hardened against
      // (it refuses a tokenless connect naming the Admin → Tokens fixit) — but
      // the env rung, which IS the CI path, never passes through `connect`.
      if (!res.ok) throw new Error(describeIngestFailure(res.status, token !== undefined))
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * What to tell the user about a refused ingest. An auth status is the common
 * case and has a concrete fix, so it names one; everything else reports the
 * status rather than guessing at a cause.
 */
function describeIngestFailure(status: number, hadToken: boolean): string {
  if (status === 401 || status === 403) {
    return hadToken
      ? `${status} — the cloud rejected this token (expired, revoked, or scoped to another workspace); the run was NOT recorded`
      : `${status} — no token was sent; set VX_CLOUD_TOKEN (mint one under Admin → Tokens). The run was NOT recorded`
  }
  if (status === 413) return `${status} — payload too large; the run was NOT recorded`
  return `${status} — the run was NOT recorded`
}
