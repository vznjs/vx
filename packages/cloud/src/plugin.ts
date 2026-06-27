// The first-party `cloud()` VxPlugin. Contributes the three run-level
// capabilities against core's plugin interface (Phase 3 of
// docs/design/core-cloud-split-2026-06.md):
//
//   backend   — route the run to a local-or-hosted `vx-cloud serve`
//               (owns the serve discovery moved out of core), else dev-mirror
//               in-process. Always returns a backend.
//   cache     — wrap the local Cache in a Turbo-wire `LayeredCache` pointed at
//               the cloud artifact store. Declines (undefined) when unconfigured
//               so core's env fallback still applies.
//   eventSink — buffer the run's WireEvents and upload them to an insights
//               endpoint on `run:end`. Declines when unconfigured.
//
// Every option falls back to an env var, so `cloud()` with no args is the
// zero-config form (it behaves like pre-split core: delegate-or-dev-mirror,
// env-configured cache, no insights upload).

import {
  LayeredCache,
  RemoteCache,
  UserError,
  type CacheLayer,
  type EventSink,
  type VxPlugin,
  type WireEvent,
} from '@vzn/vx'
import { resolveBackend } from './cli/backend.js'

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
   * Endpoint the run's WireEvent log is POSTed to for insights. Falls back to
   * `VX_CLOUD_INSIGHTS_URL`. With no URL the eventSink capability declines.
   */
  insightsUrl?: string
  /** Bearer token for the insights endpoint. Falls back to `VX_CLOUD_INSIGHTS_TOKEN`. */
  insightsToken?: string
}

/**
 * The first-party `@vzn/vx-cloud` plugin. Declared in `vx.workspace.ts` via
 * `defineWorkspace({ plugins: [cloud()] })`. Contributes backend / cache /
 * eventSink; each capability is independent and zero-config via env vars.
 */
export function cloud(opts: CloudPluginOptions = {}): VxPlugin {
  return {
    name: 'vzn/cloud',

    setup() {
      const serviceUrl = opts.serviceUrl ?? process.env['VX_SERVICE_URL']
      assertWellFormedUrl(serviceUrl, 'serviceUrl')
      assertWellFormedUrl(cacheUrlOf(opts), 'cacheUrl')
      assertWellFormedUrl(insightsUrlOf(opts), 'insightsUrl')
    },

    backend(ctx) {
      const serviceUrl = opts.serviceUrl ?? process.env['VX_SERVICE_URL']
      return resolveBackend(ctx.request.cwd, undefined, serviceUrl)
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

    eventSink(): EventSink | undefined {
      const url = insightsUrlOf(opts)
      if (!url) return undefined
      const token = opts.insightsToken ?? process.env['VX_CLOUD_INSIGHTS_TOKEN']
      return new InsightsSink(url, token)
    },
  }
}

function cacheUrlOf(opts: CloudPluginOptions): string | undefined {
  return opts.cacheUrl ?? process.env['VX_REMOTE_CACHE_URL']
}

function insightsUrlOf(opts: CloudPluginOptions): string | undefined {
  return opts.insightsUrl ?? process.env['VX_CLOUD_INSIGHTS_URL']
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
 * Buffers the run's WireEvents and uploads them as one NDJSON body to the
 * insights endpoint. Core never invokes `teardown`/`flush` (the run() finally
 * block only disposes bus subscriptions — see plugin-host.ts), so the upload
 * is triggered by the terminal `run:end` WireEvent inside `onEvent`. `flush`
 * stays as a best-effort fallback for any future host that does await it.
 */
class InsightsSink implements EventSink {
  private readonly events: WireEvent[] = []
  private uploaded = false

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
  ) {}

  onEvent(event: WireEvent): void {
    this.events.push(event)
    if (event.kind === 'run:end') void this.upload()
  }

  async flush(): Promise<void> {
    await this.upload()
  }

  private async upload(): Promise<void> {
    if (this.uploaded) return
    this.uploaded = true
    const body = this.events.map((e) => JSON.stringify(e)).join('\n')
    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' }
    if (this.token) headers['authorization'] = `Bearer ${this.token}`
    try {
      await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      // insights upload is fully optional — a down endpoint never affects a run
    }
  }
}
