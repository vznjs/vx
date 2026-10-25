// @vzn/vx-cache — `vxCache()`, a vx `cache` plugin for a server that speaks
// the vx-cache protocol (`@vzn/vx-cache-server`, its PROTOCOL.md, /v1).
// Nothing is on by default: declare it in `.vx/workspace.ts`, with the
// server's URL and a token. With no URL or token it declines and the run
// stays local. Imports core only through `@vzn/vx`.

import {
  type ArtifactInfo,
  definePlugin,
  type PluginOptionKinds,
  refuseUnknownOptions,
  type RemoteCacheLayer,
  type VxPlugin,
} from '@vzn/vx'

export interface VxCacheOptions {
  /** The server's base URL (`https://cache.example.com`), or `VX_CACHE_URL`. */
  url?: string
  /** The bearer token every request carries, or `VX_CACHE_TOKEN`. */
  token?: string
  /** Per-request deadline for reads and queries (default 30 s). */
  timeoutMs?: number
  /** … and for an upload (default 60 s). */
  uploadTimeoutMs?: number
}

const KEYS: PluginOptionKinds<VxCacheOptions> = {
  url: 'string',
  token: 'string',
  timeoutMs: 'number',
  uploadTimeoutMs: 'number',
}

/** Keys one existence query carries (the protocol's cap). */
const QUERY_MAX = 1000
/** Refs one read names (the protocol's cap). */
const READ_SCOPES_MAX = 8

/** `Vx-Read-Scopes`: an RFC 8941 list of strings. */
function readScopes(refs: readonly string[]): Record<string, string> {
  const list = refs.slice(0, READ_SCOPES_MAX)
  return list.length === 0
    ? {}
    : { 'vx-read-scopes': list.map((r) => `"${r.replace(/[\\"]/g, '\\$&')}"`).join(', ') }
}

/** A refusal, named by its status and the server's own `detail` (RFC 9457). */
async function refusal(res: Response): Promise<Error> {
  let said = ''
  try {
    const text = (await res.text()).slice(0, 2048)
    try {
      const detail = (JSON.parse(text) as { detail?: unknown }).detail
      said = typeof detail === 'string' ? detail : text
    } catch {
      said = text
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  said = said.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new Error(`HTTP ${res.status}${said === '' ? '' : `: ${said}`}`)
}

/** A deadline that names itself: the runtime's own abort says only "The operation timed out." */
function deadline(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms).unref()
  return controller.signal
}

const durationOf = (header: string | null): number | undefined => {
  const n = Number(header)
  return header !== null && header !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

const infoOf = (size: number | undefined, durationMs: number | undefined): ArtifactInfo => ({
  ...(size === undefined ? {} : { size }),
  ...(durationMs === undefined ? {} : { durationMs }),
})

/**
 * The seam: `has` is HEAD, `hasMany` the existence query, `get`/`put`
 * carry `Vx-Duration`. A refused token (401/403) throws once, for core to
 * report, and turns the layer off for the run; an upload's 403 turns off
 * uploads alone (a read token).
 */
export class VxCacheLayer implements RemoteCacheLayer {
  readonly endpoint: string
  private disabled = false
  private writesRefused = false
  /** Headers every read carries: the refs it may be answered from. */
  reads: Record<string, string> = {}

  constructor(
    private readonly config: Required<VxCacheOptions>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = config.url
  }

  private async request(
    method: string,
    path: string,
    init: { body?: Blob | string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response | undefined> {
    const res = await this.fetchImpl(`${this.config.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.token}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: deadline(init.timeoutMs ?? this.config.timeoutMs),
    })
    if (method === 'PUT' && res.status === 403) {
      const first = !this.writesRefused
      this.writesRefused = true
      if (!first) return undefined
      throw new Error(
        `${(await refusal(res)).message}: the upload was refused (a read token); uploads off for this run, reads go on`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      throw new Error(
        `${(await refusal(res)).message}: the token was refused; remote cache off for this run`,
      )
    }
    return res
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    if (this.disabled) return null
    const res = await this.request('HEAD', `/v1/artifacts/${hash}`, { headers: this.reads })
    if (res === undefined || res.status === 404) return null
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return infoOf(
      durationOf(res.headers.get('content-length')),
      durationOf(res.headers.get('vx-duration')),
    )
  }

  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    if (this.disabled) return new Map()
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / QUERY_MAX) }, (_, i) =>
        this.query(hashes.slice(i * QUERY_MAX, (i + 1) * QUERY_MAX)),
      ),
    )
    return new Map(parts.flatMap((p) => [...p]))
  }

  private async query(keys: readonly string[]): Promise<Map<string, ArtifactInfo>> {
    const res = await this.request('POST', '/v1/artifacts/query', {
      body: JSON.stringify({ keys }),
      headers: { 'content-type': 'application/json', ...this.reads },
    })
    if (res === undefined) return new Map()
    if (res.status !== 200) throw await refusal(res)
    const body = (await res.json()) as { artifacts?: unknown }
    if (typeof body.artifacts !== 'object' || body.artifacts === null) {
      throw new Error('the existence query answered no `artifacts` object')
    }
    const held = new Map<string, ArtifactInfo>()
    for (const key of keys) {
      const v = (body.artifacts as Record<string, { size?: unknown; durationMs?: unknown }>)[key]
      if (typeof v !== 'object' || v === null) continue
      const num = (n: unknown) => (typeof n === 'number' && n >= 0 ? n : undefined)
      held.set(key, infoOf(num(v.size), num(v.durationMs)))
    }
    return held
  }

  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    if (this.disabled) return null
    const res = await this.request('GET', `/v1/artifacts/${hash}`, { headers: this.reads })
    if (res === undefined) return null
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (res.status !== 200) throw await refusal(res)
    return { body: res, durationMs: durationOf(res.headers.get('vx-duration')) }
  }

  async put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void> {
    if (this.disabled || this.writesRefused) return
    const res = await this.request('PUT', `/v1/artifacts/${hash}`, {
      body,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.size),
        'vx-duration': String(Math.max(0, Math.round(meta.durationMs))),
      },
      timeoutMs: this.config.uploadTimeoutMs,
    })
    if (res === undefined) return
    // 201 stored, 200 already held: either way the server has it.
    if (!res.ok) throw await refusal(res)
  }
}

/** Options over `VX_CACHE_URL` / `VX_CACHE_TOKEN`; `undefined` = not configured. */
export function resolveVxCacheConfig(
  options: VxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): Required<VxCacheOptions> | undefined {
  const url = (options.url ?? env.VX_CACHE_URL)?.replace(/\/+$/, '')
  const token = options.token ?? env.VX_CACHE_TOKEN
  if (url === undefined || url === '' || token === undefined || token === '') return undefined
  if (!/^https?:\/\//.test(url)) throw new Error(`vxCache(): url must be http(s), got ${url}`)
  return {
    url,
    token,
    timeoutMs: options.timeoutMs ?? 30_000,
    uploadTimeoutMs: options.uploadTimeoutMs ?? 60_000,
  }
}

/**
 * Declare in `.vx/workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [vxCache({ url: 'https://cache.example.com' })] // token: VX_CACHE_TOKEN
 * ```
 */
export function vxCache(options: VxCacheOptions = {}): VxPlugin {
  refuseUnknownOptions('vxCache()', options, KEYS)
  return definePlugin(import.meta, {
    cache(ctx): RemoteCacheLayer | undefined {
      const config = resolveVxCacheConfig(options)
      if (config === undefined) return undefined
      const layer = new VxCacheLayer(config)
      layer.reads = readScopes(ctx.refs)
      return layer
    },
  })
}
