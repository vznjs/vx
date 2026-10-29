// @vzn/vx-migrate (nxCache) — a vx `cache` plugin that stores artifacts in any server
// implementing Nx's self-hosted remote cache OpenAPI spec: `GET` and `PUT`
// `/v1/cache/{hash}`, a Bearer token, `application/octet-stream` bodies,
// and an IMMUTABLE record — a second write of an existing hash is `409`.
// The wire is Nx's; the bytes are vx's own artifacts under vx's own keys,
// so the server is storage — an Nx binary cannot read them.
//
// Nothing is on by default: declare `nxCache()` in `.vx/workspace.ts` (the
// local store is the floor beneath it) and give it a server (options, or Nx's own
// environment variables so a self-hosted setup carries over). Without one
// the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import {
  definePlugin,
  type RemoteCacheLayer,
  type RemoteOpenContext,
  type VxPlugin,
  refuseUnknownOptions,
  UserError,
  type PluginOptionKinds,
} from '@vzn/vx'
import { deadline } from '../remote-deadline.js'
import { refusal } from '../remote-refusal.js'
import { OutageBreaker } from '../remote-breaker.js'
import { Cooldown, withRetry } from '../remote-retry.js'
import {
  headerValueFault,
  type KeychainRemote,
  keychainToken,
  remoteLabel,
} from '../remote-token.js'

export interface NxCacheOptions {
  /** Base URL of the cache server, or `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`. */
  url?: string
  /**
   * Bearer token, or `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, then the OS
   * keychain. `''` (option or variable) is a server that runs open: no
   * token, nothing asked.
   */
  token?: string
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number
  /** Resends of a request answered 429 / 5xx or never connected (default 1); 0 turns them off. */
  retries?: number
}

export interface NxCacheConfig {
  url: string
  /** Undefined: the layer's `open` asks the OS keychain; `''`: an open server. */
  token?: string
  timeoutMs: number
  retries: number
}

/** Resolve options over Nx's environment; `undefined` = not configured. */
export function resolveNxCacheConfig(
  options: NxCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
): NxCacheConfig | undefined {
  // Named by its source: the env's was refused as a `url` option.
  const from =
    options.url !== undefined ? 'nxCache() option "url"' : 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER'
  const url = (options.url ?? env['NX_SELF_HOSTED_REMOTE_CACHE_SERVER'])?.replace(/\/+$/, '')
  if (!url) return undefined
  // With no scheme every request failed on its own, as a bare "Invalid URL".
  if (!/^https?:\/\//.test(url))
    throw new UserError(`${from} must be an http(s) URL, got ${JSON.stringify(url)}`)
  // The URL is printed in every refusal line, so a `user:pass@` in it would
  // leak to the log. Credentials go in the access token.
  if (URL.canParse(url)) {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '')
      throw new UserError(
        `${from} carries credentials (user:pass@); pass them as the token instead`,
      )
  }
  const token = options.token ?? env['NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN']
  const fault = token === undefined ? null : headerValueFault(token)
  if (fault !== null)
    throw new Error(
      `nxCache(): the access token holds ${fault}, which no HTTP header can carry — check the secret (it is not printed)`,
    )
  const retries = options.retries ?? 1
  return {
    url,
    ...(token !== undefined ? { token } : {}),
    timeoutMs: options.timeoutMs ?? 30_000,
    retries,
  }
}

/**
 * The seam implementation over Nx's two endpoints. The spec has no
 * existence probe, so `has` (core asks it only for a `--dry` prediction;
 * the prefetch pass calls `get`) is a GET whose body is cancelled before
 * it answers, so no probe holds a connection. It kept the response for a
 * `get` of the same hash, which no caller makes. Bodies stream: `get` returns the `fetch` Response and `put`
 * sends the Blob core hands it. `put` treats any 2xx and `409` as success:
 * the record is immutable and content-addressed, so "already there" is the
 * outcome wanted. An auth failure (401/403) throws ONCE — core
 * reports it — and then turns the layer off for the rest of the process
 * (a write's 403 turns off writes alone: the read-only token);
 * the requests already in flight when it lands degrade in silence rather
 * than repeating it.
 */
export class NxRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private readonly breaker = new OutageBreaker()
  /**
   * A `403` on a write is the spec's read-only token (a CI's pull-request
   * token): uploads stop, reads go on. Read as a refused token, it turned
   * the reads off too, and every dependant looked up after the first
   * upload missed and rebuilt.
   */
  private writesRefused = false
  readonly endpoint: string
  /** The remote's rate limit, which every request of this client waits out. */
  private readonly cooldown = new Cooldown()
  /** Undefined until `open` reads the keychain; a layer never opened (a plan) asks the server nothing. */
  private token: string | undefined
  /** Set by `open` when the token came from the keychain: a refusal deletes it. */
  private forget: (() => Promise<void>) | undefined
  private readonly keychainRemote: KeychainRemote
  constructor(
    private readonly config: NxCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = Bun.sleep,
  ) {
    this.endpoint = `${config.url}/v1/cache`
    this.token = config.token
    this.keychainRemote = {
      key: this.endpoint,
      label: remoteLabel(config.url, undefined),
      env: 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN',
    }
  }

  async open(ctx: RemoteOpenContext): Promise<void> {
    if (this.token !== undefined) return
    this.token = await keychainToken(ctx, this.keychainRemote)
    this.forget = () => ctx.forgetSecret({ key: this.keychainRemote.key })
  }

  /**
   * `undefined` = the token was refused and the refusal is ALREADY
   * reported, so the caller degrades to its miss value in silence. Only the
   * first refusal throws, and a run's calls are concurrent: six projects
   * under a bad token printed five identical lines before this (2026-09-20).
   */
  private async request(
    method: 'GET' | 'PUT',
    hash: string,
    body?: Blob,
  ): Promise<Response | undefined> {
    if (this.token === undefined) return undefined
    const headers: Record<string, string> = {}
    if (this.token !== '') headers['Authorization'] = `Bearer ${this.token}`
    if (body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = String(body.size)
    } else {
      // Nx's own client asks for the binary type. A gateway that keys binary
      // media on Accept (AWS API Gateway) base64-encodes a `*/*` response, and
      // every hit read as a corrupt artifact (nx#33092).
      headers['Accept'] = 'application/octet-stream'
    }
    const res = await this.breaker.send(
      () =>
        withRetry(
          () =>
            this.fetchImpl(`${this.config.url}/v1/cache/${hash}`, {
              method,
              headers,
              ...(body === undefined ? {} : { body }),
              signal: deadline(this.config.timeoutMs),
            }),
          this.config.retries,
          this.wait,
          this.cooldown,
        ),
      method === 'GET',
    )
    if (method === 'PUT' && res.status === 403) {
      const first = !this.writesRefused
      this.writesRefused = true
      if (!first) return undefined
      // The status and the server's own words, as turboCache() says them.
      throw new Error(
        `${(await refusal(res)).message}: access forbidden (a read-only token cannot write); uploads off for this run, reads go on`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      const said = (await refusal(res)).message
      const why =
        res.status === 401
          ? 'missing or invalid token'
          : 'access forbidden (the token may not read)'
      if (this.forget === undefined)
        throw new Error(`${said}: ${why}; remote cache off for this run`)
      await this.forget()
      throw new Error(
        `${said}: ${why}; removed it from the OS keychain, so the next run asks again; remote cache off for this run`,
      )
    }
    return res
  }

  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    const res = await this.fetch(hash)
    // The Nx wire carries no producing-task duration.
    return res === null ? null : { body: res, durationMs: undefined }
  }

  private async fetch(hash: string): Promise<Response | null> {
    if (this.disabled) return null
    const res = await this.request('GET', hash)
    if (res === undefined) return null
    if (res.status !== 200) {
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      throw await refusal(res)
    }
    return res
  }

  async has(hash: string): Promise<{ size?: number } | null> {
    const res = await this.fetch(hash)
    if (res === null) return null
    await res.body?.cancel()
    const size = Number(res.headers.get('content-length') ?? NaN)
    return Number.isFinite(size) ? { size } : {}
  }

  // Nx's record carries no duration.
  async put(hash: string, body: Blob): Promise<void | false> {
    // Nothing sent, so no upload is counted.
    if (this.disabled || this.writesRefused) return false
    const res = await this.request('PUT', hash, body)
    if (res === undefined) return false
    // The spec answers 200; a store behind it may say 201 or 204.
    if (res.ok || res.status === 409) return
    throw await refusal(res)
  }
}

/** Each option `NxCacheOptions` names, with its kind: derived from the type, so the two cannot drift. */
const NX_CACHE_KEYS: PluginOptionKinds<NxCacheOptions> = {
  url: 'string',
  token: 'string',
  timeoutMs: 'number',
  retries: 'number',
}

/**
 * Declare in `.vx/workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [nxCache({ url: 'https://cache.example.com', token: process.env.CACHE_TOKEN })]
 * ```
 *
 * Declines without a url, so it is safe to leave declared.
 */
export function nxCache(options: NxCacheOptions = {}): VxPlugin {
  refuseUnknownOptions('nxCache()', options, NX_CACHE_KEYS)
  // At the call: in the `cache` hook a laptop with no server named passed
  // what failed the first CI run. A NaN never reaches the bound, and the
  // request would be resent forever; a zero timeout aborted every request
  // as it started.
  const { retries, timeoutMs: ms } = options
  if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0))
    throw new UserError(`nxCache() option "retries" must be a whole number ≥ 0, got ${retries}`)
  if (ms !== undefined && !(Number.isFinite(ms) && ms > 0))
    throw new UserError(`nxCache() option "timeoutMs" must be a positive number of ms, got ${ms}`)
  return definePlugin(import.meta, {
    cache(): RemoteCacheLayer | undefined {
      const config = resolveNxCacheConfig(options)
      return config === undefined ? undefined : new NxRemoteCache(config)
    },
  })
}
