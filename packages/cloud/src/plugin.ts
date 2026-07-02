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
  UserError,
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
   * back to `VX_REMOTE_CACHE_URL`. With no URL the cache capability declines.
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

    cache(ctx): CacheLayer | undefined {
      const url = cacheUrlOf(opts)
      const token = opts.cacheToken ?? process.env['VX_REMOTE_CACHE_TOKEN']
      if (!url || !token) return undefined

      const config: ConstructorParameters<typeof RemoteCache>[0] = { baseUrl: url, token }
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

      ctx.warn(`cloud cache: ${url}`)
      return new LayeredCache(ctx.localCache, new RemoteCache(config), {
        onRemoteError: (err) => ctx.warn(`[vx] cloud cache: ${err.message}`),
        policy: ctx.policy,
      })
    },

    telemetry(ctx: TelemetryContext): TelemetrySink | undefined {
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
      const localUrl = detectLocalIngestUrl()
      if (!localUrl) return undefined
      const token = opts.ingestToken ?? ingestTokenFromEnv()
      return new CloudIngestSink(localUrl, token, (m) => ctx.warn(m))
    },
  }
}

function cacheUrlOf(opts: CloudPluginOptions): string | undefined {
  return opts.cacheUrl ?? process.env['VX_REMOTE_CACHE_URL']
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
 * Auto-detect a local `vx-cloud serve` via its per-user advertisement (origin +
 * pid, written at a MACHINE-LEVEL path so it's found from any workspace). When
 * present + alive, push telemetry to `<origin>/v1/ingest`. Returns undefined
 * when no serve is running (a plain `vx run` then declines). One fs read — no
 * network, no heavy import.
 */
function detectLocalIngestUrl(): string | undefined {
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
  return `${info.origin.replace(/\/+$/, '')}/v1/ingest`
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
  ) {}

  onRunSummary(summary: RunSummaryRecord): void {
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.uploaded || this.summary === undefined) return
    this.uploaded = true
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) headers['authorization'] = `Bearer ${this.token}`
    // A clearable timer (NOT AbortSignal.timeout, whose internal timer is not
    // unref'd and would keep the CLI process alive for the full timeout after
    // the POST already resolved — a 5s "hang" at the end of every run).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.summary),
        signal: controller.signal,
      })
    } catch (err) {
      // telemetry push is fully optional — a down endpoint never affects a run
      this.warn(`[vx] cloud ingest: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
