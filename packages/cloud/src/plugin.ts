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

import { existsSync } from 'node:fs'
import {
  LayeredCache,
  RemoteCache,
  UserError,
  type CacheContext,
  type CacheLayer,
  type RunSummaryRecord,
  type TelemetryContext,
  type TelemetrySink,
  type VxPlugin,
} from '@vzn/vx'
import { activeEnvironment } from './environments.js'
import { pidAlive, readServeInfo } from './serve-info.js'

// NB: the heavy service machinery (backend resolution → serve / dev hub) is
// loaded LAZILY inside `backend()` via a dynamic import, so merely DECLARING
// `cloud()` in a workspace config (the common case) keeps the run's config-eval
// light — it imports this module + core only, not the whole service layer.

export interface CloudPluginOptions {
  /**
   * Origin of a `vx-cloud serve` to delegate runs to (e.g. `https://…` or a
   * `wss://` host). Falls back to `VX_SERVICE_URL`. When unreachable the
   * backend degrades to local — a misconfigured service never breaks a run.
   */
  serviceUrl?: string
  /**
   * Base URL of the cloud artifact store (Turbo `/v8/artifacts` wire). Falls
   * back to `VX_REMOTE_CACHE_URL`, then — with neither set — to the ACTIVE
   * connected environment when its serve advertises the artifact store
   * (`/v1/meta` `artifacts: true`). With none the cache capability declines.
   */
  cacheUrl?: string
  /** Bearer token for the artifact store. Falls back to `VX_REMOTE_CACHE_TOKEN`. */
  cacheToken?: string
  /** Optional Turbo tenant id, sent as `?teamId=`. Falls back to `VX_REMOTE_CACHE_TEAM_ID`. */
  cacheTeamId?: string
  /** Optional Turbo tenant slug, sent as `?slug=`. Falls back to `VX_REMOTE_CACHE_SLUG`. */
  cacheSlug?: string
  /** HMAC artifact-signing key. Falls back to `VX_REMOTE_CACHE_SIGNATURE_KEY`. */
  cacheSignatureKey?: string
  /**
   * The cloud ingest endpoint a RunSummaryRecord is POSTed to at run end.
   * Falls back to `VX_CLOUD_INGEST_URL`, then the legacy `VX_CLOUD_INSIGHTS_URL`.
   * With no URL the telemetry capability declines.
   */
  ingestUrl?: string
  /** Bearer token for ingest. Falls back to `VX_CLOUD_INGEST_TOKEN`, then `VX_CLOUD_INSIGHTS_TOKEN`. */
  ingestToken?: string
  /**
   * Distribute runs across `vx-cloud agent` machines (advisory expected
   * agent count). Falls back to `VX_CLOUD_DISTRIBUTE`. When set, the
   * backend capability returns the distributed submitter; a serve must be
   * configured or advertised (hard error otherwise — distribution is an
   * explicit opt-in, unlike ambient delegation). Unset → zero cost.
   */
  distribute?: number
}

/**
 * The first-party `@vzn/vx-cloud` plugin. Declared in `vx.workspace.ts` via
 * `defineWorkspace({ plugins: [cloud()] })`. Contributes backend / cache /
 * telemetry; each capability is independent and zero-config via env vars.
 */
export function cloud(opts: CloudPluginOptions = {}): VxPlugin {
  return {
    name: 'vzn/cloud',

    setup() {
      const serviceUrl = opts.serviceUrl ?? process.env['VX_SERVICE_URL']
      assertWellFormedUrl(serviceUrl, 'serviceUrl')
      assertWellFormedUrl(cacheUrlOf(opts), 'cacheUrl')
      assertWellFormedUrl(ingestUrlOf(opts), 'ingestUrl')
    },

    async backend(ctx) {
      // Distribution rung (VX_CLOUD_DISTRIBUTE / cloud({ distribute })):
      // above delegation, explicit opt-in. Unset → this rung is ONE env
      // read (the zero-overhead decline invariant, pinned by tests).
      const distribute = distributeOf(opts)
      if (distribute !== undefined) {
        const target = resolveDistributeTarget(opts)
        if (target === undefined) {
          throw new UserError(
            'VX_CLOUD_DISTRIBUTE is set but no vx-cloud serve is configured or advertised — ' +
              'start one (`vx-cloud serve`) or set VX_SERVICE_URL / connect an environment',
          )
        }
        const { distributedBackend } = await import('./dist/submit.js')
        return distributedBackend({
          origin: target.origin,
          ...(target.token !== undefined ? { token: target.token } : {}),
          expectedAgents: distribute,
          warn: (line) => ctx.warn(line),
        })
      }
      // Only take over execution when a service is EXPLICITLY configured —
      // option > env var > a connected environment that OPTED IN with
      // `delegate: true` (delegation executes against request.cwd on the
      // server, only correct when it shares/mirrors the filesystem, so
      // connecting for the dashboard never silently moves execution).
      // Unconfigured → decline (return undefined) so core uses its own local
      // backend with NO serve-discovery probe — declaring cloud() in a
      // workspace then costs nothing on the run hot path. The backend
      // machinery is imported lazily here, never at config-eval time.
      const serviceUrl = opts.serviceUrl ?? process.env['VX_SERVICE_URL']
      if (serviceUrl) {
        const { resolveBackend } = await import('./cli/backend.js')
        return resolveBackend(ctx.request.cwd, undefined, serviceUrl)
      }
      const env = activeEnvironment()
      if (env?.delegate === true) {
        const { resolveBackend } = await import('./cli/backend.js')
        return resolveBackend(ctx.request.cwd, undefined, env.url, env.token)
      }
      return undefined
    },

    cache(ctx): CacheLayer | undefined | Promise<CacheLayer | undefined> {
      // Explicit config wins and is never second-guessed: with a cacheUrl
      // (option or VX_REMOTE_CACHE_URL) the environment rung is not
      // consulted and no /v1/meta probe ever fires. A half-set explicit
      // config (URL, no token) declines like before.
      const url = cacheUrlOf(opts)
      if (url) {
        const token = opts.cacheToken ?? process.env['VX_REMOTE_CACHE_TOKEN']
        if (!token) return undefined
        return buildCloudCache(ctx, opts, url, token)
      }
      // Environment rung: the ACTIVE connected environment, when its serve
      // advertises the artifact store (`/v1/meta` `artifacts: true` — probed
      // lazily ONCE per process). No environment → decline with zero
      // network, so a plain run stays byte-identical.
      const env = activeEnvironment()
      if (env === undefined) return undefined
      return (async () => {
        if (!(await serveAdvertisesArtifacts(env.url))) return undefined
        return buildCloudCache(ctx, opts, env.url, env.token ?? '')
      })()
    },

    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
      // Agent sentinel: a distribution agent's per-assignment scoped runs
      // must not spam the ingest store with 1-task invocations. Other
      // telemetry plugins (e.g. otel()) are unaffected by design.
      if (process.env['VX_CLOUD_AGENT'] === '1') return undefined
      // The push ladder, first match wins: plugin options > env vars (CI —
      // they beat the active environment, matching DOCKER_HOST > active
      // context) > the connected environment (memoized one-fs-read consult) >
      // AUTO-DETECT a local `vx-cloud serve` via its per-user advertisement
      // (zero-config local dashboard from ANY workspace) > decline, so a
      // plain run is unaffected. Each rung pairs the URL with ITS OWN token.
      const explicitUrl = ingestUrlOf(opts)
      if (explicitUrl) {
        const token = opts.ingestToken ?? ingestTokenFromEnv()
        return new CloudIngestSink(explicitUrl, token, (m) => ctx.warn(m))
      }
      const env = activeEnvironment()
      if (env !== undefined) {
        const url = `${env.url.replace(/\/+$/, '')}/v1/ingest`
        return new CloudIngestSink(url, env.token, (m) => ctx.warn(m))
      }
      const local = detectLocalIngest()
      if (!local) return undefined
      const token = opts.ingestToken ?? ingestTokenFromEnv()
      return new CloudIngestSink(local.url, token, (m) => ctx.warn(m), local.socket)
    },
  }
}

function cacheUrlOf(opts: CloudPluginOptions): string | undefined {
  return opts.cacheUrl ?? process.env['VX_REMOTE_CACHE_URL']
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
 * Where the distributed submission goes — the same resolution ladder the
 * other capabilities use: explicit option/env > the active environment >
 * the advertised local serve. Reachability is verified by the backend
 * itself (unreachable → hard error, §5.1).
 */
function resolveDistributeTarget(
  opts: CloudPluginOptions,
): { origin: string; token?: string } | undefined {
  const explicit = opts.serviceUrl ?? process.env['VX_SERVICE_URL'] ?? process.env['VX_CLOUD_URL']
  if (explicit !== undefined && explicit !== '') {
    const token = process.env['VX_CLOUD_TOKEN']
    return { origin: explicit, ...(token !== undefined && token !== '' ? { token } : {}) }
  }
  const env = activeEnvironment()
  if (env !== undefined) {
    return { origin: env.url, ...(env.token !== undefined ? { token: env.token } : {}) }
  }
  const info = readServeInfo()
  if (info !== undefined && pidAlive(info.pid)) return { origin: info.origin }
  return undefined
}

function ingestUrlOf(opts: CloudPluginOptions): string | undefined {
  return (
    opts.ingestUrl ?? process.env['VX_CLOUD_INGEST_URL'] ?? process.env['VX_CLOUD_INSIGHTS_URL']
  )
}

function ingestTokenFromEnv(): string | undefined {
  return process.env['VX_CLOUD_INGEST_TOKEN'] ?? process.env['VX_CLOUD_INSIGHTS_TOKEN']
}

/**
 * The Turbo-wire LayeredCache construction, faithfully mirroring core's
 * `remote-cache-setup.ts` semantics (tenancy / signing / timeout knobs) —
 * shared by the explicit-config rung and the environment rung.
 */
function buildCloudCache(
  ctx: CacheContext,
  opts: CloudPluginOptions,
  baseUrl: string,
  token: string,
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

  ctx.warn(`cloud cache: ${baseUrl}`)
  return new LayeredCache(ctx.localCache, new RemoteCache(config), {
    onRemoteError: (err) => ctx.warn(`[vx] cloud cache: ${err.message}`),
    policy: ctx.policy,
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

/**
 * Auto-detect a local `vx-cloud serve` via its per-user advertisement (origin +
 * pid + optional unix socket, written at a MACHINE-LEVEL path so it's found
 * from any workspace). When present + alive, push telemetry to
 * `<origin>/v1/ingest` — over the advertised unix socket when it exists (the
 * hardened local transport; TCP stays the fallback). Returns undefined when no
 * serve is running (a plain `vx run` then declines). One fs read — no network,
 * no heavy import.
 */
function detectLocalIngest(): { url: string; socket?: string } | undefined {
  const info = readServeInfo()
  if (info === undefined) return undefined
  // Never push to a serve running in THIS process — that's the serve executing
  // a delegated run, and POSTing to itself mid-request would deadlock (the WS
  // handler would await an ingest request it must answer). The serve records
  // its own pid, so a same-pid match means "self".
  if (info.pid === process.pid) return undefined
  // Ignore a stale advertisement left by a serve that died without cleanup —
  // otherwise every run wastes a (swallowed) POST to a dead origin.
  if (!pidAlive(info.pid)) return undefined
  return {
    url: `${info.origin.replace(/\/+$/, '')}/v1/ingest`,
    ...(info.socket !== undefined && existsSync(info.socket) ? { socket: info.socket } : {}),
  }
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
  // Summary-only: no streaming records needed.
  readonly wants: ReadonlyArray<never> = []
  private summary: RunSummaryRecord | undefined
  private uploaded = false

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly warn: (message: string) => void,
    /**
     * A local serve's advertised unix socket. When set, the push dials it
     * (Bun fetch `unix` option) instead of TCP — the 0600 socket's file
     * permissions are the auth, so no token is needed on that path. A failed
     * socket dial falls back to the TCP origin (never-fail either way).
     */
    private readonly socketPath?: string,
  ) {}

  onRunSummary(summary: RunSummaryRecord): void {
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.uploaded || this.summary === undefined) return
    this.uploaded = true
    const body = JSON.stringify(this.summary)
    if (this.socketPath !== undefined) {
      try {
        await this.post('http://localhost/v1/ingest', body, { unix: this.socketPath })
        return
      } catch {
        // socket dial failed (removed/refused) — fall back to the TCP origin
      }
    }
    try {
      await this.post(this.url, body)
    } catch (err) {
      // telemetry push is fully optional — a down endpoint never affects a run
      this.warn(`[vx] cloud ingest: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async post(url: string, body: string, extra?: { unix: string }): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) headers['authorization'] = `Bearer ${this.token}`
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
        ...(extra !== undefined ? { unix: extra.unix } : {}),
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
