// @vzn/vx-migrate (turboCache) — a vx `cache` plugin that stores artifacts in any
// server speaking Turborepo's remote cache API (`/v8/artifacts`): Vercel's
// hosted cache, or a self-hosted implementation of the published OpenAPI
// spec. The wire is Turbo's; the bytes are vx's own artifacts under vx's
// own keys, so the server is storage — a Turbo binary cannot read them.
//
// Nothing is on by default: declare `turboCache()` in `.vx/workspace.ts`
// (the local store is the floor beneath it) and give it a URL and a token (options, or
// Turbo's own environment variables and turbo.json's `remoteCache` so a
// self-hosted setup carries over; the OS keychain last). With no URL, team
// or token the plugin DECLINES and the run stays local.
//
// Imports core only through the public `@vzn/vx` specifier.
import { readFileSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type ArtifactInfo,
  definePlugin,
  type LentAccess,
  type RemoteCacheLayer,
  type RemoteOpenContext,
  type VxPlugin,
  refuseUnknownOptions,
  UserError,
  type PluginOptionKinds,
} from '@vzn/vx'
import { deadline, MAX_TIMER_MS } from '../remote-deadline.js'
import { checkRemoteUrl } from '../remote-url.js'
import { refusal } from '../remote-refusal.js'
import { keyedByRef, readScopes, remoteScope, type RemoteScope } from './scope.js'
import { OutageBreaker } from '../remote-breaker.js'
import { Cooldown, withRetry } from '../remote-retry.js'
import {
  headerValueFault,
  type KeychainRemote,
  keychainToken,
  remoteLabel,
} from '../remote-token.js'
import {
  exchangeOidc,
  type OidcConfig,
  oidcSettings,
  revokeOidc,
  type TurboOidcOptions,
} from './oidc.js'

export interface TurboCacheOptions {
  /** Base URL of the cache server (`https://cache.example.com`), or `TURBO_API`; with a token and neither, Vercel's hosted cache, as for `turbo`. */
  url?: string
  /** Bearer token every request carries, or `TURBO_TOKEN`, OIDC, `.turbo/config.json`, then the OS keychain. */
  token?: string
  /**
   * On GitHub Actions with no token or `TURBO_TOKEN`, exchange the job's
   * OIDC token for a short-lived one, revoked when the run ends. `true`:
   * Vercel's hosted cache with Vercel's endpoints; any other server names
   * its `tokenUrl`. The job needs `permissions: id-token: write`.
   */
  oidc?: true | TurboOidcOptions
  /** `teamId` query parameter, or `TURBO_TEAMID`; the signature folds it, `''` when unset, as Turbo's does. */
  teamId?: string
  /** `slug` query parameter (a team slug), or `TURBO_TEAM`. */
  teamSlug?: string
  /**
   * Sign uploads and verify downloads with Turbo's artifact signature
   * (HMAC-SHA256, `x-artifact-tag`), or `TURBO_REMOTE_CACHE_SIGNATURE_KEY`
   * where turbo.json sets `remoteCache.signature: true`, as Turbo reads it.
   * The option needs at least 32 bytes; the env key warns below that,
   * refused only under turbo.json's `futureFlags.longerSignatureKey`, as
   * in Turbo. Used raw. A download whose tag does not verify is a miss,
   * never a restore.
   */
  signatureKey?: string
  /**
   * Per-request deadline for HEAD/GET/POST, or `TURBO_REMOTE_CACHE_TIMEOUT`
   * / turbo.json's `remoteCache.timeout` (whole seconds); default 30 s.
   * 0 is no deadline, as in Turbo.
   */
  timeoutMs?: number
  /** … and for PUT, or `TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT` / `remoteCache.uploadTimeout`; default 60 s. */
  uploadTimeoutMs?: number
  /** Resends of a request answered 429 / 5xx or never connected (default 1, Turbo's); 0 turns them off. */
  retries?: number
  /**
   * Send Turbo's preflight (`OPTIONS`) before each artifact request and
   * follow its `Location`, or `TURBO_PREFLIGHT` / turbo.json's
   * `remoteCache.preflight`; default off.
   */
  preflight?: boolean
  /**
   * How branches stay apart (default `'header'`): every read names the run's
   * refs in `x-artifact-read-scopes`, for a server that files writes by the
   * CI token. `'key'` also folds the run's ref into each key and reads each
   * ref's key in order, for a server that ignores the header. The server's
   * OIDC policy alone decides where a write lands.
   */
  scope?: RemoteScope
}

/** turbo.json's `remoteCache` block: the source below Turbo's environment, as in Turbo. */
export interface TurboJsonRemoteCache {
  apiUrl?: unknown
  signature?: unknown
  teamId?: unknown
  teamSlug?: unknown
  enabled?: unknown
  timeout?: unknown
  uploadTimeout?: unknown
  preflight?: unknown
  /** turbo.json's `futureFlags.longerSignatureKey`, which `remoteCacheOf` hoists here. */
  longerSignatureKey?: unknown
}

/** `.turbo/config.json`'s fields, under any of the spellings Turbo accepts. */
export interface TurboLocalConfig {
  apiUrl?: unknown
  teamId?: unknown
  teamSlug?: unknown
  token?: unknown
}

export interface TurboCacheConfig {
  url: string
  /** Undefined: the layer's `open` exchanges OIDC or asks the OS keychain. */
  token?: string
  /** The job's OIDC exchange, when `oidc` is set and GitHub hands the job a token. */
  oidc?: OidcConfig
  /** `oidc` is set on GitHub Actions, but the job has no ID-token permission. */
  oidcMissing?: true
  teamId?: string
  teamSlug?: string
  signatureKey?: string
  timeoutMs: number
  uploadTimeoutMs: number
  retries: number
  preflight: boolean
}

/** Turbo's signature message prefix (`crates/turborepo-cache/src/signature_authentication.rs`). */
const SIGNATURE_MESSAGE_PREFIX = 'artifact-signature:v2'
export const MIN_SIGNATURE_KEY_LENGTH = 32

// Bun's own hasher and the global `crypto`, not `node:crypto`: importing that
// module cost every `@vzn/vx-migrate` user 6.6 ms at startup, remote cache
// or not (G-121).
/** A size and a duration as the wire spells them (a header string, a JSON number), kept when they are counts. */
function infoOf(size: unknown, durationMs: unknown): ArtifactInfo {
  const count = (v: unknown): number | undefined => {
    const n = typeof v === 'string' && v !== '' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const s = count(size)
  const d = count(durationMs)
  return { ...(s === undefined ? {} : { size: s }), ...(d === undefined ? {} : { durationMs: d }) }
}

function updateLength(mac: Bun.CryptoHasher, byteLength: number): void {
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(byteLength))
  mac.update(len)
}

/**
 * `x-artifact-tag`: base64(HMAC-SHA256(key, fields)) where every field is
 * prefixed with its byte length as a little-endian u64 — prefix, hash,
 * team id, body — exactly as Turbo generates and verifies it. The body is
 * read as a stream, so a file-backed Blob is signed without being held.
 */
export async function artifactTag(
  key: Uint8Array,
  hash: string,
  teamId: string,
  body: Blob,
): Promise<string> {
  const mac = new Bun.CryptoHasher('sha256', key)
  for (const field of [
    Buffer.from(SIGNATURE_MESSAGE_PREFIX),
    Buffer.from(hash),
    Buffer.from(teamId),
  ]) {
    updateLength(mac, field.byteLength)
    mac.update(field)
  }
  updateLength(mac, body.size)
  for await (const chunk of body.stream()) mac.update(chunk)
  return mac.digest('base64')
}

/**
 * The temps not yet removed. Core's signal exit is `process.exit`, which
 * awaits nothing, so a Ctrl-C between the download and the last read left
 * the artifact's temp behind (item 848); the process's `exit` event
 * removes what is still listed.
 */
const liveTemps = new Set<string>()
let exitHooked = false
function trackTemp(file: string): void {
  liveTemps.add(file)
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const f of liveTemps) {
      try {
        unlinkSync(f)
        // quiet: a temp file already gone at exit
      } catch {
        // never written, or gone
      }
    }
  })
}

async function removeTemp(file: string): Promise<void> {
  // Listed until the unlink lands: an exit in between would otherwise find
  // nothing to remove and leave the temp (item 868).
  // quiet: a temp file already gone
  await unlink(file).catch(() => undefined)
  liveTemps.delete(file)
}

/** The verified temp as a body that deletes the temp once read to the end or cancelled. */
function unlinkingStream(file: string): ReadableStream<Uint8Array> {
  const reader = Bun.file(file).stream().getReader()
  const remove = () => removeTemp(file)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await remove()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (err) {
        await remove()
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await remove()
    },
  })
}

function tagsEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'base64')
  const b = Buffer.from(actual, 'base64')
  if (a.byteLength !== b.byteLength) return false
  // Constant time over the bytes, as timingSafeEqual is.
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Where `turbo` itself sends a token with no `url`: Vercel's hosted Remote Cache. */
export const VERCEL_API = 'https://vercel.com/api'

/** Resolve options over Turbo's environment; `undefined` = not configured. */
export function resolveTurboCacheConfig(
  options: TurboCacheOptions,
  env: Record<string, string | undefined> = Bun.env,
  file: TurboJsonRemoteCache = {},
  /** The repo's `.turbo/config.json` (`turbo link` writes it): below the environment, above turbo.json. */
  local: TurboLocalConfig = {},
  warn: (message: string) => void = (m) => console.error(`[vx] plugin '@vzn/vx-migrate': ${m}`),
): TurboCacheConfig | undefined {
  // `enabled: false` turns Turbo's remote cache off whatever the env says;
  // options name a cache for vx alone, and win.
  if (file.enabled === false && options.url === undefined && options.token === undefined)
    return undefined
  const fromFile = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  // Empty is unset, as Turbo reads it: a fork's pull request gets `''` for a
  // secret, and `${{ vars.TURBO_API }}` is `''` for an unset variable.
  const set = (name: string): string | undefined => env[name] || undefined
  // A Vercel build hands Turbo its cache as VERCEL_ARTIFACTS_TOKEN and
  // _OWNER (the team id), taken where TURBO_TOKEN with a team is not set
  // (Turbo's `override_env.rs`); unread, turboCache() declined on Vercel.
  const turboPair = set('TURBO_TOKEN') && (set('TURBO_TEAMID') || set('TURBO_TEAM'))
  const vercel =
    !turboPair && set('VERCEL_ARTIFACTS_TOKEN') && set('VERCEL_ARTIFACTS_OWNER')
      ? { token: set('VERCEL_ARTIFACTS_TOKEN'), teamId: set('VERCEL_ARTIFACTS_OWNER') }
      : { token: undefined, teamId: turboPair ? undefined : set('VERCEL_ARTIFACTS_OWNER') }
  const given = (options.token ?? set('TURBO_TOKEN') ?? vercel.token) || undefined
  // OIDC sits under the variables and over the config files.
  const idTokenUrl = set('ACTIONS_ID_TOKEN_REQUEST_URL')
  const idTokenBearer = set('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
  const exchanges =
    options.oidc !== undefined &&
    given === undefined &&
    idTokenUrl !== undefined &&
    idTokenBearer !== undefined
  const token = given ?? (exchanges ? undefined : fromFile(local.token) || undefined)
  const teamId =
    options.teamId ??
    set('TURBO_TEAMID') ??
    vercel.teamId ??
    fromFile(local.teamId) ??
    fromFile(file.teamId)
  const teamSlug =
    options.teamSlug ?? set('TURBO_TEAM') ?? fromFile(local.teamSlug) ?? fromFile(file.teamSlug)
  // Turbo's own default when a token or a team is set and no URL is:
  // Vercel's hosted Remote Cache. A token alone is a configured cache, as it
  // is for `turbo`; a URL or a team without one asks the OS keychain at
  // `open`; none of them is the declined, local run.
  // Each source with its name: TURBO_API was refused as a `url`
  // option the workspace never set.
  const [rawUrl, urlFrom] =
    options.url !== undefined
      ? [options.url, 'turboCache() option "url"']
      : set('TURBO_API') !== undefined
        ? [set('TURBO_API'), 'TURBO_API']
        : fromFile(local.apiUrl) !== undefined
          ? [fromFile(local.apiUrl), '.turbo/config.json apiUrl']
          : fromFile(file.apiUrl) !== undefined
            ? [fromFile(file.apiUrl), 'turbo.json remoteCache.apiUrl']
            : [token || teamId || teamSlug ? VERCEL_API : undefined, 'url']
  const url = rawUrl?.replace(/\/+$/, '')
  if (!url) return undefined
  checkRemoteUrl(url, urlFrom)
  const oidc =
    options.oidc === undefined
      ? undefined
      : oidcSettings(options.oidc, url === VERCEL_API, teamId ?? teamSlug)
  const fault = token === undefined ? null : headerValueFault(token)
  if (fault !== null)
    throw new Error(
      `turboCache(): the token holds ${fault}, which no HTTP header can carry — check the secret (it is not printed)`,
    )
  const preflight =
    options.preflight ??
    truthy(env['TURBO_PREFLIGHT'], 'TURBO_PREFLIGHT') ??
    file.preflight === true
  // Turbo signs only under `remoteCache.signature: true`; the env key alone
  // signs nothing there, and a short one here refused the whole cache.
  const signing = file.signature === true
  const envKey = signing ? env['TURBO_REMOTE_CACHE_SIGNATURE_KEY'] || undefined : undefined
  const signatureKey = options.signatureKey ?? envKey
  // Turbo signs with no key as it fails every request: no usable remote. Read
  // unsigned here, the bytes a signing repo refuses were restored.
  if (signing && signatureKey === undefined) {
    warn(
      'turbo.json sets remoteCache.signature but TURBO_REMOTE_CACHE_SIGNATURE_KEY is unset: remote cache off for this run, as for turbo',
    )
    return undefined
  }
  if (signatureKey !== undefined) {
    const bytes = Buffer.byteLength(signatureKey)
    // Turbo only warns about a short key unless `futureFlags.longerSignatureKey`
    // is set; refusing it here failed a run Turbo runs.
    if (bytes < MIN_SIGNATURE_KEY_LENGTH) {
      if (options.signatureKey !== undefined || file.longerSignatureKey === true)
        throw new Error(
          `turboCache(): signatureKey must be at least ${MIN_SIGNATURE_KEY_LENGTH} bytes`,
        )
      warn(
        `TURBO_REMOTE_CACHE_SIGNATURE_KEY is ${bytes} bytes; ${MIN_SIGNATURE_KEY_LENGTH} or more is safe (Turbo enforces it under futureFlags.longerSignatureKey)`,
      )
    }
  }
  const retries = options.retries ?? 1
  return {
    url,
    ...(token !== undefined ? { token } : {}),
    ...(oidc !== undefined && exchanges
      ? { oidc: { ...oidc, idTokenUrl: idTokenUrl!, idTokenBearer: idTokenBearer! } }
      : {}),
    ...(oidc !== undefined && !exchanges && given === undefined && env['GITHUB_ACTIONS'] === 'true'
      ? { oidcMissing: true as const }
      : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamSlug ? { teamSlug } : {}),
    ...(signatureKey !== undefined ? { signatureKey } : {}),
    timeoutMs:
      options.timeoutMs ??
      seconds(env['TURBO_REMOTE_CACHE_TIMEOUT'], 'TURBO_REMOTE_CACHE_TIMEOUT') ??
      seconds(file.timeout, 'remoteCache.timeout') ??
      30_000,
    uploadTimeoutMs:
      options.uploadTimeoutMs ??
      seconds(env['TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT'], 'TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT') ??
      seconds(file.uploadTimeout, 'remoteCache.uploadTimeout') ??
      60_000,
    retries,
    preflight,
  }
}

/** Turbo's `truth_env_var`: 1/true, 0/false; unset or empty is `undefined`. */
function truthy(v: string | undefined, name: string): boolean | undefined {
  if (v === undefined || v === '') return undefined
  if (!/^(1|0|true|false)$/.test(v))
    throw new Error(`turboCache(): ${name} should be 1 or 0, got ${JSON.stringify(v)}`)
  return v === '1' || v === 'true'
}

/**
 * Turbo's timeout, whole seconds, as ms; `undefined` when unset. A value
 * Turbo would refuse is refused here rather than read as some other wait.
 */
function seconds(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0)
    throw new Error(`turboCache(): ${name} must be whole seconds ≥ 0, got ${JSON.stringify(v)}`)
  return n * 1000
}

/** A response's text, or null (the rest cancelled) once it passes `max` bytes. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel()
    return null
  }
  const reader = res.body?.getReader()
  if (reader === undefined) return ''
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * A signed body is written whole before its tag can be checked, so a
 * server that never ended one filled the temp's disk (L-8). Core refuses
 * an artifact past its 2 GiB ceiling (zstd's bound on it here) anyway, so
 * nothing larger is ever worth keeping.
 */
const MAX_SIGNED_BODY = 2 * 1024 ** 3 + ((2 * 1024 ** 3) >> 8) + 64 * 1024

/** A lent token ending sooner than this is exchanged again first, so an agent's request never carries a spent one. */
const LEND_MARGIN_MS = 5 * 60_000

/** Statuses of a server that has no batch query. */
const NO_BATCH = new Set([404, 405, 501])

/**
 * The most hashes one batch query may carry: Vercel answers more with 400
 * "Too many hashes. Limit is 100." (main f71b377 asked 107 at once, and
 * the run planned as if none were held).
 */
const BATCH_MAX = 100

/**
 * The seam implementation: `has` is HEAD, `hasMany` is the batch query,
 * `get`/`put` carry `x-artifact-duration` (and the tag when signing). An
 * auth failure (401/403) throws ONCE — core reports it — and then
 * turns the layer off for the rest of the process (an upload's 403 turns off
 * uploads alone: the read-only token), so a bad token costs one
 * line, not one per task — the requests already in flight when it lands
 * degrade in silence rather than repeating it.
 *
 * Bodies stream both ways: `put` sends the Blob core hands it, `get`
 * returns the `fetch` Response. With a signature key the tag must verify
 * before core sees a byte, so a signed download lands in a temp under
 * `tempDir` first and is handed over only once it has.
 */
export class TurboRemoteCache implements RemoteCacheLayer {
  private disabled = false
  private readonly breaker = new OutageBreaker()
  /**
   * A `403` on an upload is a read-only token or server
   * (turborepo-remote-cache's `READ_ONLY` and its JWTs without the write
   * scope): uploads stop, reads go on. Read as a refused token, it turned
   * the reads off too, and every task after the first upload missed.
   */
  private writesRefused = false
  /**
   * Keys this process saw the server lack (a 404, a batch answer): `put`
   * asks no HEAD for them. Turbo's PUT replaces a stored artifact and an
   * entry is immutable, so any other key is asked first.
   */
  private readonly absent = new Set<string>()
  /**
   * Keys whose GET this process answered 200. Core saves a key after its
   * hit only when that hit did not restore (bad bytes, a tag that does not
   * verify), so `put` sends it over the stored one: its HEAD saw 200 and
   * kept the bad entry for every later run.
   */
  private readonly served = new Set<string>()
  private readonly key: Uint8Array | undefined
  readonly endpoint: string
  /** Undefined until `open` reads the keychain; a layer never opened (a plan) asks the server nothing. */
  private token: string | undefined
  /** Set by `open` when the token came from the keychain: a refusal deletes it. */
  private forget: (() => Promise<void>) | undefined
  /** The tokens OIDC exchanges gave, the last one current, each revoked when the run ends. */
  private exchanged: string[] = []
  /** When the current exchanged token ends (epoch ms), when the server said. */
  private expiresAt: number | undefined
  /** Set by `open` when this machine has a lent token and no token of its own: read per request. */
  private borrowed: (() => string | undefined) | undefined
  /** The token a run running its tasks here lent (`CacheContext.lent`). */
  lent: (() => string | undefined) | undefined
  private readonly keychainRemote: KeychainRemote
  /** The remote's rate limit, which every request of this client waits out. */
  private readonly cooldown = new Cooldown()
  /** Headers every read carries: the refs it may be answered from (`readScopes`). */
  reads: Record<string, string> = {}
  constructor(
    private readonly config: TurboCacheConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tempDir: string = tmpdir(),
    private readonly wait: (ms: number) => Promise<void> = Bun.sleep,
    /** The most a signed body may hold before its tag is checked (a test lowers it). */
    private readonly maxSignedBody: number = MAX_SIGNED_BODY,
  ) {
    this.key = config.signatureKey === undefined ? undefined : Buffer.from(config.signatureKey)
    this.endpoint = `${config.url}/v8/artifacts`
    this.token = config.token
    const team = config.teamId ?? config.teamSlug
    this.keychainRemote = {
      key: team === undefined ? this.endpoint : `${this.endpoint}#${team}`,
      label: remoteLabel(config.url, team),
      env: 'TURBO_TOKEN',
    }
  }

  async open(ctx: RemoteOpenContext): Promise<void> {
    const lent = this.lent?.() === undefined ? undefined : this.lent
    if (this.config.oidcMissing && lent === undefined)
      ctx.warn(
        'oidc: GitHub gave this job no OIDC token: it needs `permissions: id-token: write` (a fork or Dependabot pull request never gets one)',
      )
    if (this.token !== undefined) return
    // A lent token beats this machine's own OIDC: the server files a write
    // by the token, so an agent's own (another workflow, another ref)
    // filed the task where its run could not read it.
    if (lent !== undefined) {
      this.borrowed = lent
      return
    }
    if (this.config.oidc !== undefined) {
      try {
        await this.exchange()
      } catch (err) {
        throw new Error(
          `oidc: ${err instanceof Error ? err.message : String(err)}; local cache only this run`,
        )
      }
      return
    }
    this.token = await keychainToken(ctx, this.keychainRemote)
    this.forget = () => ctx.forgetSecret({ key: this.keychainRemote.key })
  }

  private async exchange(): Promise<void> {
    const got = await exchangeOidc(this.config.oidc!, this.fetchImpl, this.wait)
    this.token = got.token
    this.expiresAt = got.expiresAt
    this.exchanged.push(got.token)
  }

  /**
   * The token an OIDC exchange gave this run, for a machine that runs its
   * tasks (`RemoteCacheLayer.lend`); exchanged again when it ends within
   * five minutes. A token of any other kind is never lent.
   */
  async lend(): Promise<LentAccess | undefined> {
    if (this.exchanged.length === 0) return undefined
    if (this.expiresAt !== undefined && this.expiresAt - Date.now() < LEND_MARGIN_MS)
      await this.exchange()
    return {
      token: this.token!,
      ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
    }
  }

  private bearer(): string | undefined {
    return this.borrowed?.() ?? this.token
  }

  private url(pathname: string): string {
    const u = new URL(`${this.config.url}/v8/artifacts${pathname}`)
    // Turbo sends a team id only in Vercel's `team_` form (its API client's
    // `add_team_params`); a personal account's owner id is not one, and the
    // signature, which folds the id as given, is unaffected.
    if (this.config.teamId?.startsWith('team_')) u.searchParams.set('teamId', this.config.teamId)
    if (this.config.teamSlug) u.searchParams.set('slug', this.config.teamSlug)
    return u.toString()
  }

  private headers(extra: Record<string, string> = {}, auth = true): Record<string, string> {
    return {
      ...(auth ? { Authorization: `Bearer ${this.bearer()}` } : {}),
      'x-artifact-client-interactive': process.stdout.isTTY ? '1' : '0',
      ...extra,
    }
  }

  /**
   * Turbo's preflight: an `OPTIONS` to the request's URL names the method
   * and headers to come; the answer's `Location` (relative to `url`) is
   * where the request goes, as given — a signed storage URL signs its own
   * query, so nothing is appended — and the token goes along only when
   * `Access-Control-Allow-Headers` admits `Authorization` (or `*`), so it
   * never reaches a third-party store. The answer's status is not read, as
   * in Turbo. A redirect is not followed: its `Location` is the answer, and
   * the token's verdict stays the API's. Following one let the redirected
   * host's `Access-Control-Allow-Headers` admit the token to itself.
   */
  private async preflight(
    url: string,
    method: string,
    headers: Record<string, string>,
    signal: () => AbortSignal | undefined,
  ): Promise<{ url: string; auth: boolean }> {
    const s = signal()
    const res = await this.fetchImpl(url, {
      method: 'OPTIONS',
      headers: {
        Authorization: `Bearer ${this.bearer()}`,
        'Access-Control-Request-Method': method === 'HEAD' ? 'GET' : method,
        'Access-Control-Request-Headers': ['Authorization', ...Object.keys(headers)].join(', '),
      },
      redirect: 'manual',
      ...(s === undefined ? {} : { signal: s }),
    })
    await res.body?.cancel()
    const location = res.headers.get('location')
    const allowed = res.headers.get('access-control-allow-headers') ?? ''
    return {
      url: location === null ? url : new URL(location, this.config.url).toString(),
      auth:
        allowed.trim() === '*' ||
        allowed.split(',').some((h) => h.trim().toLowerCase() === 'authorization'),
    }
  }

  /**
   * `undefined` = the token was refused and the refusal is ALREADY
   * reported, so the caller degrades to its miss value in silence. Only the
   * first refusal throws, and a run's calls are concurrent: six projects
   * under a bad token printed five identical lines before this (2026-09-20).
   */
  private async request(
    method: string,
    pathname: string,
    init: { body?: Blob | string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response | undefined> {
    if (this.bearer() === undefined) return undefined
    const timeoutMs = init.timeoutMs ?? this.config.timeoutMs
    // 0 is Turbo's "no deadline".
    const signal = () => (timeoutMs === 0 ? undefined : deadline(timeoutMs))
    // The batch query is never preflighted, as in Turbo.
    const preflight = this.config.preflight && method !== 'POST'
    const res = await this.breaker.send(
      () =>
        withRetry(
          async () => {
            const extra = init.headers ?? {}
            const to = preflight
              ? await this.preflight(this.url(pathname), method, extra, signal)
              : { url: this.url(pathname), auth: true }
            const s = signal()
            return this.fetchImpl(to.url, {
              method,
              headers: this.headers(extra, to.auth),
              ...(init.body === undefined ? {} : { body: init.body }),
              ...(s === undefined ? {} : { signal: s }),
            })
          },
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
      // The status and the server's own words (`refusal`): a scope it
      // refuses and a token it no longer takes read alike.
      throw new Error(
        `${(await refusal(res)).message}: the upload was refused (a read-only token or server); uploads off for this run, reads go on`,
      )
    }
    if (res.status === 401 || res.status === 403) {
      const first = !this.disabled
      this.disabled = true
      if (!first) return undefined
      const said = (await refusal(res)).message
      if (this.forget === undefined)
        throw new Error(`${said}: the token was refused; remote cache off for this run`)
      await this.forget()
      throw new Error(
        `${said}: the token was refused; removed it from the OS keychain, so the next run asks again; remote cache off for this run`,
      )
    }
    return res
  }

  /** Revoke each token this run exchanged, once; a throw is the caller's warning. */
  async revoke(): Promise<void> {
    const tokens = this.exchanged.splice(0)
    for (const token of tokens)
      await revokeOidc(this.config.oidc!, token, this.fetchImpl, this.wait)
  }

  async has(hash: string): Promise<ArtifactInfo | null> {
    if (this.disabled) return null
    const res = await this.request('HEAD', `/${hash}`, { headers: this.reads })
    if (res === undefined) return null
    if (res.status === 200)
      return infoOf(res.headers.get('content-length'), res.headers.get('x-artifact-duration'))
    if (res.status === 404) {
      this.absent.add(hash)
      return null
    }
    throw new Error(`HTTP ${res.status}`)
  }

  async hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    if (this.disabled || hashes.length === 0) return this.disabled ? new Map() : null
    if (hashes.length <= BATCH_MAX) return this.batch(hashes)
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(hashes.length / BATCH_MAX) }, (_, i) =>
        this.batch(hashes.slice(i * BATCH_MAX, (i + 1) * BATCH_MAX)),
      ),
    )
    if (parts.some((p) => p === null)) return null
    return new Map(parts.flatMap((p) => [...p!]))
  }

  private async batch(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> {
    const res = await this.request('POST', '', {
      body: JSON.stringify({ hashes }),
      headers: { 'Content-Type': 'application/json', ...this.reads },
    })
    if (res === undefined) return new Map()
    if (res.status !== 200) {
      // A server with no batch query (404, 405, 501) is asked per hash. Any
      // other refusal was silent: main f71b377's probe gave no answer and no
      // one could say why, and DTE sized the run as if every task ran.
      if (NO_BATCH.has(res.status)) {
        await res.body?.cancel()
        return null
      }
      throw await refusal(res, 'batch query answered ')
    }
    // An answer per hash is a few hundred bytes of ArtifactInfo; a reply
    // past this bound is no answer, read no further than the bound (L-9).
    const bound = hashes.length * 4096 + 64 * 1024
    const text = await boundedText(res, bound)
    if (text === null) throw new Error(`batch query answered past ${bound} bytes; read no further`)
    // A 200 that is no JSON object (a proxy's page, `null`, `[]`) threw a
    // parser's line that named no query, or read as every hash absent:
    // DTE sized the run as if every task ran.
    let info: unknown
    try {
      info = JSON.parse(text)
    } catch {
      // quiet: refused below, with what came
      info = undefined
    }
    if (typeof info !== 'object' || info === null || Array.isArray(info)) {
      const said = text.replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new Error(
        `batch query answered HTTP 200 with no JSON object${said === '' ? '' : `: ${said}`}`,
      )
    }
    // Each hash answers ArtifactInfo, null, or `{ error: { message } }`; an
    // error entry is not a stored artifact, and it was counted as one (a GET
    // spent on a 404, item 929).
    const held = new Map<string, ArtifactInfo>()
    for (const h of hashes) {
      const v = (info as Record<string, unknown>)[h]
      if (typeof v !== 'object' || v === null || 'error' in v) this.absent.add(h)
      else {
        const { size, taskDurationMs } = v as { size?: unknown; taskDurationMs?: unknown }
        held.set(h, infoOf(size, taskDurationMs))
      }
    }
    return held
  }

  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    if (this.disabled) return null
    // A gateway that keys binary media on Accept base64-encodes a `*/*`
    // response, and every hit read as a corrupt artifact (nx#33092's class).
    const res = await this.request('GET', `/${hash}`, {
      headers: { Accept: 'application/octet-stream', ...this.reads },
    })
    if (res === undefined) return null
    if (res.status !== 200) {
      if (res.status === 404) {
        await res.body?.cancel()
        this.absent.add(hash)
        return null
      }
      throw await refusal(res)
    }
    this.served.add(hash)
    const duration = Number(res.headers.get('x-artifact-duration'))
    const durationMs = Number.isFinite(duration) && duration > 0 ? duration : undefined
    if (this.key === undefined) return { body: res, durationMs }
    return { body: await this.verified(this.key, hash, res), durationMs }
  }

  /**
   * The tag's message carries the body's length BEFORE its bytes, and a
   * chunked response declares no length, so the body is written to the temp
   * first and signed from there: two passes over a file, never one in memory.
   */
  private async verified(key: Uint8Array, hash: string, res: Response): Promise<Response> {
    const refused = () => new Error('the artifact signature did not verify — treated as a miss')
    const tag = res.headers.get('x-artifact-tag')
    if (tag === null) {
      await res.body?.cancel()
      throw refused()
    }
    const temp = path.join(this.tempDir, `vx-turbo-${hash}-${crypto.randomUUID()}`)
    trackTemp(temp)
    try {
      const max = this.maxSignedBody
      const past = () => new Error(`the signed artifact runs past ${max} bytes — treated as a miss`)
      if (Number(res.headers.get('content-length') ?? 0) > max) {
        await res.body?.cancel()
        throw past()
      }
      let n = 0
      const counted = res.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            n += chunk.byteLength
            if (n > max) controller.error(past())
            else controller.enqueue(chunk)
          },
        }),
      )
      await Bun.write(temp, new Response(counted ?? null))
      const expected = await artifactTag(key, hash, this.config.teamId ?? '', Bun.file(temp))
      if (!tagsEqual(expected, tag)) throw refused()
    } catch (err) {
      await removeTemp(temp)
      throw err
    }
    return new Response(unlinkingStream(temp))
  }

  missing(hash: string): void {
    this.absent.add(hash)
  }

  async put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void | false> {
    // Nothing sent, so no upload is counted.
    if (this.disabled || this.writesRefused) return false
    if (!this.absent.has(hash) && !this.served.has(hash)) {
      // Part of the upload, so under its deadline. Any answer but 200 or 404
      // uploads: a lost store costs more. A server the HEAD cannot reach
      // fails the put, as the PUT would.
      const head = await this.request('HEAD', `/${hash}`, {
        headers: this.reads,
        timeoutMs: this.config.uploadTimeoutMs,
      })
      if (head === undefined) return false
      if (head.status === 200) return
      if (head.status === 404) this.absent.add(hash)
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.size),
      'x-artifact-duration': String(Math.max(0, Math.round(meta.durationMs))),
    }
    if (this.key !== undefined) {
      headers['x-artifact-tag'] = await artifactTag(this.key, hash, this.config.teamId ?? '', body)
    }
    const res = await this.request('PUT', `/${hash}`, {
      body,
      headers,
      timeoutMs: this.config.uploadTimeoutMs,
    })
    if (res === undefined) return false
    // Turbo's client takes any 2xx (`error_for_status`); a server's 201 or
    // 204 stored the artifact and was counted a failed upload.
    if (!res.ok) throw await refusal(res)
    this.absent.delete(hash)
    this.served.delete(hash)
  }
}

/**
 * The repo's `.turbo/config.json`, by Turbo's field names and their
 * aliases (`apiurl`, `ApiUrl`, `APIURL`, …); `{}` when absent or unreadable.
 */
function localConfigOf(root: string): TurboLocalConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(root, '.turbo', 'config.json'), 'utf8'))
    // quiet: a local config file: none read is none linked
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}
  const byLower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    apiUrl: byLower.get('apiurl'),
    teamId: byLower.get('teamid'),
    teamSlug: byLower.get('teamslug'),
    token: byLower.get('token'),
  }
}

/** The root turbo.json's (or turbo.jsonc's) `remoteCache`; `{}` when there is none or it does not parse. */
function remoteCacheOf(root: string): TurboJsonRemoteCache {
  for (const name of ['turbo.json', 'turbo.jsonc']) {
    let text: string
    try {
      text = readFileSync(path.join(root, name), 'utf8')
      // quiet: a local config file: none read is none declared
    } catch {
      continue
    }
    try {
      const json = Bun.JSONC.parse(text) as {
        remoteCache?: unknown
        futureFlags?: { longerSignatureKey?: unknown }
      } | null
      const rc = json?.remoteCache
      const longerSignatureKey = json?.futureFlags?.longerSignatureKey
      return {
        ...(typeof rc === 'object' && rc !== null ? (rc as TurboJsonRemoteCache) : {}),
        ...(longerSignatureKey === undefined ? {} : { longerSignatureKey }),
      }
      // quiet: a local config file: none read is none declared
    } catch {
      return {}
    }
  }
  return {}
}

/** Each option `TurboCacheOptions` names, with its kind: derived from the type, so the two cannot drift. */
const TURBO_CACHE_KEYS: PluginOptionKinds<TurboCacheOptions> = {
  url: 'string',
  token: 'string',
  teamId: 'string',
  teamSlug: 'string',
  signatureKey: 'string',
  timeoutMs: 'number',
  uploadTimeoutMs: 'number',
  retries: 'number',
  preflight: 'boolean',
  oidc: 'any',
  scope: 'string',
}

/**
 * The number options, refused at the call: in the `cache` hook a laptop
 * with no remote named passed what failed the first CI run.
 */
function refuseBadNumbers(options: TurboCacheOptions): void {
  // A NaN never reaches the bound, and the request would be resent forever.
  const { retries } = options
  if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0))
    throw new UserError(`turboCache() option "retries" must be a whole number ≥ 0, got ${retries}`)
  // 0 is no deadline, as Turbo reads it; a negative or non-number one made
  // AbortSignal.timeout throw on every request, and one past the longest
  // timer aborted each as it started (Turbo's own env values are held).
  for (const name of ['timeoutMs', 'uploadTimeoutMs'] as const) {
    const ms = options[name]
    if (ms !== undefined && !(ms >= 0 && ms <= MAX_TIMER_MS))
      throw new UserError(
        `turboCache() option "${name}" must be ms ≥ 0 (0: none) up to ${MAX_TIMER_MS}, got ${ms}`,
      )
  }
}

/**
 * Declare in `.vx/workspace.ts`; the local store stays the floor beneath it:
 *
 * ```ts
 * plugins: [turboCache({ url: 'https://cache.example.com', token: process.env.CACHE_TOKEN })]
 * ```
 *
 * Declines with no URL, team or token, so it is safe to leave declared.
 */
export function turboCache(options: TurboCacheOptions = {}): VxPlugin {
  refuseUnknownOptions('turboCache()', options, TURBO_CACHE_KEYS)
  refuseBadNumbers(options)
  // At the call too, as vxCache() checks its url: in the hook alone, a verb
  // that opens no cache (`vx show`) took a url every run then failed on.
  const url = options.url?.replace(/\/+$/, '')
  if (url) checkRemoteUrl(url, 'turboCache() option "url"')
  const scope = remoteScope('turboCache', options.scope)
  // The run's layer and warn, for `teardown` to revoke an exchanged token.
  let opened: { layer: TurboRemoteCache; warn: (m: string) => void } | undefined
  return definePlugin(import.meta, {
    cache(ctx): RemoteCacheLayer | undefined {
      const config = resolveTurboCacheConfig(
        options,
        Bun.env,
        remoteCacheOf(ctx.workspaceRoot),
        localConfigOf(ctx.workspaceRoot),
        (m) => ctx.warn(`[vx] plugin '@vzn/vx-migrate': ${m}`),
      )
      if (config === undefined) return undefined
      // A signed download waits in a temp until its tag checks: in vx's
      // cache directory, which the sandbox walls, not the shared temp dir a
      // sandboxed task may read (L-45).
      const layer = new TurboRemoteCache(config, fetch, ctx.cacheDir)
      layer.reads = readScopes(ctx.refs)
      layer.lent = ctx.lent
      if (config.oidc !== undefined) opened = { layer, warn: ctx.warn }
      return scope === 'key' ? keyedByRef(layer, ctx.refs) : layer
    },
    async teardown() {
      const run = opened
      opened = undefined
      await run?.layer
        .revoke()
        .catch((err: unknown) =>
          run.warn(
            `[vx] plugin '@vzn/vx-migrate': oidc: ${err instanceof Error ? err.message : String(err)}; the token expires on its own`,
          ),
        )
    },
  })
}
