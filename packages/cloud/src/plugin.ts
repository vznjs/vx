// The first-party `cloud()` VxPlugin. Contributes the run-level capabilities
// against core's plugin interface:
//
//   backend   — route the run to a local-or-hosted `vx-cloud serve`
//               (owns the serve discovery moved out of core), else dev-mirror
//               in-process. Always returns a backend.
//   cache     — wrap the local Cache in a Turbo-wire `LayeredCache` pointed at
//               the cloud artifact store. Declines (undefined) when unconfigured
//               so core's env fallback still applies.
//   telemetry — push the canonical RunSummaryRecord to the cloud's /v1/ingest
//               endpoint at run end. Observe-only (it cannot change a run) and
//               never-fail. Declines when unconfigured. This is the data path:
//               the cloud service ingests these summaries into its OWN store
//               and serves the dashboard from there — it no longer reads a
//               developer's private cache.db. See
//               docs/design/observability-architecture-2026-06.md.
//
// Every option falls back to an env var, so `cloud()` with no args is the
// zero-config form (it behaves like pre-split core: delegate-or-dev-mirror,
// env-configured cache, no telemetry push).

import {
  LayeredCache,
  RemoteCache,
  resolveCacheScope,
  UserError,
  type CacheContext,
  type CachePolicy,
  type CacheLayer,
  type RunSummaryRecord,
  type TelemetryContext,
  type TelemetryRecord,
  type TelemetrySink,
  type VxPlugin,
} from '@vzn/vx'
import { activeEnvironment } from './environments.js'
import { appendGithubSummary } from './github-summary.js'
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
   * remote cache (`/v8/artifacts`), and distributed execution — so a
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
  /** Optional Turbo tenant id, sent as `?teamId=`. Falls back to `VX_REMOTE_CACHE_TEAM_ID`. */
  cacheTeamId?: string
  /** Optional Turbo tenant slug, sent as `?slug=`. Falls back to `VX_REMOTE_CACHE_SLUG`. */
  cacheSlug?: string
  /** HMAC artifact-signing key. Falls back to `VX_REMOTE_CACHE_SIGNATURE_KEY`. */
  cacheSignatureKey?: string
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
 *      `VX_SERVICE_URL` / `VX_REMOTE_CACHE_URL` / `VX_CLOUD_INGEST_URL`
 *      aliases), paired with `VX_CLOUD_TOKEN` / `VX_CLOUD_PR_TOKEN`;
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
    firstEnv(
      'VX_CLOUD_URL',
      'VX_SERVICE_URL',
      'VX_REMOTE_CACHE_URL',
      'VX_CLOUD_INGEST_URL',
      'VX_CLOUD_INSIGHTS_URL',
    )
  if (explicitUrl !== undefined) {
    const token =
      opts.token ?? firstEnv('VX_CLOUD_TOKEN', 'VX_REMOTE_CACHE_TOKEN', 'VX_CLOUD_INGEST_TOKEN')
    const prToken = opts.prToken ?? firstEnv('VX_CLOUD_PR_TOKEN', 'VX_REMOTE_CACHE_PR_TOKEN')
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
            'VX_REMOTE_CACHE_URL',
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
      // One env-file read, shared by the ambient-distribute + delegate rungs
      // (memoized; only happens when cloud() is declared). No environment
      // connected → both rungs skip → decline → core's localBackend, so a plain
      // `vx run` keeps its zero-overhead fast path.
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

      // Ambient DELEGATION (run the whole run on the server instead of locally)
      // stays a deliberate opt-in: it executes against request.cwd on the
      // server, only correct when the server shares/mirrors the filesystem. So
      // a plain `VX_CLOUD_URL` connection NEVER silently moves execution — only
      // an environment connected with `--delegate` does.
      if (env?.delegate === true) {
        const { resolveBackend } = await import('./cli/backend.js')
        return resolveBackend(undefined, env.url, env.token)
      }
      return undefined
    },

    cache(ctx): CacheLayer | undefined | Promise<CacheLayer | undefined> {
      // The remote cache is INTERNAL to the connection: the same `vx-cloud`
      // you connect to hosts `/v8/artifacts`, so no separate cache URL/token.
      // Which token you present decides the trust tier (server-enforced) — the
      // trusted token, else the fork-PR token. A connection with no token
      // (a local open serve) declines: the local cache already has the bytes.
      const conn = resolveConnection(opts)
      if (conn === undefined) return undefined
      const token = conn.token ?? conn.prToken
      if (token === undefined) return undefined
      // An explicitly-configured URL is trusted as-is; a DISCOVERED serve
      // (active environment) is capability-probed (`/v1/meta artifacts:true`,
      // memoized) so connecting for the dashboard alone doesn't wrongly route
      // the cache at a serve that doesn't host it.
      if (conn.source === 'explicit') {
        return buildCloudCache(ctx, opts, conn.url, token, ctx.policy)
      }
      return (async () => {
        if (!(await serveAdvertisesArtifacts(conn.url))) return undefined
        return buildCloudCache(ctx, opts, conn.url, token, ctx.policy)
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
      // on the job page whether or not a serve is attached. Nothing → decline,
      // so a plain local `vx run` is still untouched.
      const ghaSummary = firstEnv('GITHUB_STEP_SUMMARY')
      if (conn === undefined && ghaSummary === undefined) return undefined
      return new CloudIngestSink({
        ...(conn !== undefined
          ? {
              connection: {
                baseUrl: conn.url,
                ...(conn.token !== undefined ? { token: conn.token } : {}),
              },
            }
          : {}),
        warn: (m) => ctx.warn(m),
        logsEnabled: logsEnabled(opts),
        ...(ghaSummary !== undefined ? { githubSummaryPath: ghaSummary } : {}),
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
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new UserError(`invalid VX_CLOUD_DISTRIBUTE: ${raw} (expected a positive agent count)`)
  }
  return n
}

/**
 * The Turbo-wire LayeredCache construction, mirroring core's
 * `remote-cache-setup.ts` (tenancy / signing / timeout knobs). The trust tier
 * is carried by the `token` (server-enforced) — the client just presents it.
 */
function buildCloudCache(
  ctx: CacheContext,
  opts: CloudPluginOptions,
  baseUrl: string,
  token: string,
  policy: CachePolicy,
): CacheLayer {
  const config: ConstructorParameters<typeof RemoteCache>[0] = { baseUrl, token }
  const teamId = opts.cacheTeamId ?? process.env['VX_REMOTE_CACHE_TEAM_ID']
  if (teamId) config.teamId = teamId
  const slug = opts.cacheSlug ?? process.env['VX_REMOTE_CACHE_SLUG']
  if (slug) config.slug = slug
  const signatureKey = opts.cacheSignatureKey ?? process.env['VX_REMOTE_CACHE_SIGNATURE_KEY']
  if (signatureKey) config.signatureKey = signatureKey
  const timeoutMs = process.env['VX_REMOTE_CACHE_TIMEOUT_MS']
  if (timeoutMs) {
    const n = Number(timeoutMs)
    if (Number.isFinite(n) && n > 0) config.timeoutMs = n
  }
  // Untrusted per-PR isolation: one fork PR's untrusted writes/reads are
  // partitioned from another's on the serve.
  const cacheScope = resolveCacheScope(process.env)
  if (cacheScope !== undefined) config.cacheScope = cacheScope

  ctx.warn(`cloud cache: ${baseUrl}`)
  return new LayeredCache(ctx.localCache, new RemoteCache(config), {
    onRemoteError: (err) => ctx.warn(`[vx] cloud cache: ${err.message}`),
    policy,
  })
}

// The /v1/meta capability probe, memoized per origin for the process — the
// cache capability is consulted once per run, so one short-bounded GET is
// the whole cost, and only when a connected environment exists at all.
const metaProbeMemo = new Map<string, Promise<boolean>>()

function serveAdvertisesArtifacts(url: string): Promise<boolean> {
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
      const meta = (await res.json()) as { artifacts?: unknown }
      return meta.artifacts === true
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
  private readonly logs?: TaskLogBuffer
  private readonly connection?: SinkConnection
  private readonly warn: (message: string) => void
  private readonly githubSummaryPath?: string

  constructor(opts: {
    /** A serve to POST to. Absent → the sink only writes the GitHub summary. */
    connection?: SinkConnection
    warn: (message: string) => void
    logsEnabled?: boolean
    /** `$GITHUB_STEP_SUMMARY` — append the run's result table when in CI. */
    githubSummaryPath?: string
  }) {
    if (opts.connection !== undefined) this.connection = opts.connection
    this.warn = opts.warn
    if (opts.githubSummaryPath !== undefined) this.githubSummaryPath = opts.githubSummaryPath
    // Log capture only makes sense when there's a serve to ship tails to.
    if (opts.logsEnabled === true && opts.connection !== undefined) {
      this.logs = new TaskLogBuffer()
      this.wants = ['task.log', 'task.end']
    } else {
      this.wants = []
    }
  }

  onRecord(record: TelemetryRecord): void {
    if (this.logs === undefined) return
    if (record.kind === 'task.log') this.logs.append(record.taskId, record.chunk)
    else if (record.kind === 'task.end') {
      this.logs.finish(record.taskId, record.status, record.cacheSource, record.hash)
    }
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
      await this.send('/v1/ingest', JSON.stringify(this.summary), 'cloud ingest')
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
    if (this.githubSummaryPath !== undefined) {
      await appendGithubSummary(this.githubSummaryPath, this.summary, this.warn)
    }
  }

  /** POST a body to a serve path; every error swallowed + warned (telemetry
   *  never fails a run). */
  private async send(pathname: string, body: string, label: string): Promise<void> {
    try {
      await this.post(`${this.connection!.baseUrl}${pathname}`, body)
    } catch (err) {
      this.warn(`[vx] ${label}: ${err instanceof Error ? err.message : String(err)}`)
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
      await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
