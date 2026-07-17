// The serve-hosted artifact store — the vx-native `/v1/cache/:hash` wire
// (docs/design/native-cache-wire-2026-07.md; the Turbo `/v8/artifacts`
// surface is gone). Raw storage lives behind the `BlobBackend` seam
// (docs/design/s3-blob-backend-2026-07.md): the default `LocalDirBackend` is
// a flat dir of `<hash>.tar.zst` files per scope — the artifact IS the local
// cache's own on-disk format, shipped verbatim — while an `S3Backend`
// offloads the bytes to an S3-compatible bucket so the controller stores no
// artifact bytes at rest (GET answers 307 to a pre-signed URL; PUT still
// proxies THROUGH the store's gates, then uploads and unlinks the spool).
// This store keeps ALL policy: trust scopes, immutability, the streaming byte
// cap, the zstd-magic gate, hash validation, metadata semantics.
//
// Wire metadata is `x-vx-duration-ms` (the producing task's duration) and
// `x-vx-digest` (`xxh3:<hex>` over the artifact bytes) — sidecar files beside
// a local artifact, S3 user metadata (`x-amz-meta-vx-*`) on an offloaded one.
// The digest is stored and echoed back but NOT verified server-side — the
// CLIENT verifies it against the received bytes, which covers the corruption
// directions that matter (a corrupt store or a truncating transport degrade
// to a cache miss at the consumer, never a restored artifact).
//
// TRUST SCOPES (docs/design/cache-trust-scopes-2026-07.md +
// cloud-platform-2026-07.md §8.1). The store is partitioned by a tenancy
// prefix + a tier: `org/<orgId>/ws/<workspaceId>/<tier>[/<sub>]`, ALL
// SERVER-DERIVED from the presented token — never client-supplied. The org is
// the top tenant boundary (one org's token can never read another's key); the
// workspace is the token's bound workspace, or a shared `_org` segment for an
// org-wide token (its cache is shared across the org's workspaces). The tier
// boundary is the fork-PR CVE-class fix: an `untrusted` writer (a fork-PR CI
// job) can write only the `untrusted` scope and read `untrusted` ∪ `trusted`;
// a `trusted` writer (protected branch) writes and reads only `trusted`. So a
// poisoned artifact an untrusted context places NEVER feeds a trusted build,
// and an untrusted context can NEVER write into the trusted scope — no matter
// what cache key it computes. A `bucket` override on the principal replaces
// the tenant prefix with a flat `<bucket>/<tier>` scope base (e.g.
// `default/trusted`); it is a test-only seam — the store-policy unit tests use
// it to exercise the tier/scope logic without provisioning orgs. The platform
// gate never sets it, so a real request is always org/workspace-partitioned.
// Blob keys mirror the scope layout, so the model holds on S3 by
// construction: a pre-signed URL binds ONE server-derived scope key.

import os from 'node:os'
import path from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import { LocalDirBackend } from './blob/local.js'
import type { BlobBackend, BlobListEntry } from './blob/backend.js'
import { readTextBounded } from './http-body.js'

/** PUT bodies above this are refused with 413. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export type Tier = 'trusted' | 'untrusted'

/**
 * Reserved workspace segment for a token NOT bound to a specific workspace
 * (an org-wide token) — its cache is shared across the org's workspaces. Not a
 * valid UUID, so it can never collide with a real workspace id.
 */
export const ORG_SHARED_WS = '_org'

/**
 * The authenticated identity of a request, derived server-side from its token.
 * The scope base is the tenancy prefix `org/<orgId>/ws/<workspaceId ?? _org>`;
 * `workspaceId` is present only for a workspace-scoped token. `bucket` is a
 * legacy/test override — when set it IS the scope base (`<bucket>/<tier>`), used
 * by the transitional single-tenant serve and the store-policy unit tests.
 * Never carries a client-declared value for the org / workspace / tier.
 */
export interface Principal {
  orgId: string
  workspaceId?: string
  tier: Tier
  bucket?: string
}

/** Default principal for the SPA catch-all (no cache op) and direct
 *  store-policy tests — the flat `default/trusted` layout via the `bucket`
 *  seam. The platform gate always builds a real token-derived principal. */
export const DEFAULT_PRINCIPAL: Principal = { orgId: 'default', tier: 'trusted', bucket: 'default' }

/**
 * The scope base a principal reads/writes under: an explicit `bucket` override
 * (transitional serve / unit tests), else the tenant prefix. Server-derived —
 * a client value never reaches here.
 */
function basePrefix(p: Principal): string {
  return p.bucket ?? `org/${p.orgId}/ws/${p.workspaceId ?? ORG_SHARED_WS}`
}

// The hash becomes a filename — accept only a safe path token so a hostile
// hash can't traverse out of the store dir. (vx hashes are 16-hex; the wider
// token keeps other RemoteCacheLayer implementations working.)
const HASH_RE = /^[a-zA-Z0-9_-]{1,128}$/
// Scope segments are server-derived, but validate them anyway (defense in
// depth) so a future bug that lets a value flow from the wire can't traverse.
const SEGMENT_RE = /^[a-zA-Z0-9_.-]{1,128}$/
// Per-request fan-out cap for `hasMany` so one batch probe (up to
// BATCH_HASH_CAP hashes × up to 2 read scopes each) can't flood the backend.
const HASMANY_CONCURRENCY = 32
// The most hashes one `POST /v1/cache/batch` may carry — the client chunks at
// this width; the server rejects a larger list (no silent truncation).
export const BATCH_HASH_CAP = 1024
// Body cap for `/v1/cache/batch` — BATCH_HASH_CAP hashes at ≤128 chars each
// plus JSON overhead fits comfortably; anything larger is refused with 413.
const MAX_BATCH_BODY_BYTES = 256 * 1024

/**
 * Scopes a principal may READ, in priority order, each tagged with its tier.
 * An untrusted context reads its own sub-scope first, then falls through to the
 * trusted baseline (so PRs are warm off `main`); a trusted context reads only
 * trusted — it NEVER consumes an untrusted (poisonable) artifact.
 */
function readScopeSpecs(p: Principal, sub: string): { scope: string; tier: Tier }[] {
  const base = basePrefix(p)
  // Untrusted reads ITS OWN sub-scope (a per-PR partition) + the trusted
  // baseline — NEVER another PR's untrusted scope. So one fork PR can neither
  // read nor poison another's cache; the blast radius of an untrusted write is
  // exactly one PR, and trusted is never consumed.
  return p.tier === 'untrusted'
    ? [
        { scope: `${base}/untrusted/${sub}`, tier: 'untrusted' },
        { scope: `${base}/trusted`, tier: 'trusted' },
      ]
    : [{ scope: `${base}/trusted`, tier: 'trusted' }]
}

function readScopes(p: Principal, sub: string): string[] {
  return readScopeSpecs(p, sub).map((s) => s.scope)
}

/** The single scope a principal WRITES: trusted is flat; untrusted is
 *  per-PR-partitioned so PRs never write into each other's scope. */
function writeScope(p: Principal, sub: string): string {
  const base = basePrefix(p)
  return p.tier === 'untrusted' ? `${base}/untrusted/${sub}` : `${base}/trusted`
}

// A stored artifact is immutable, so a junk PUT body (a buggy client, a
// proxy error page, an empty upload) would permanently lock its key —
// re-executions could never re-upload the real bytes. Gate PUT on the zstd
// frame magic (artifacts are always `.tar.zst`): a 4-byte sanity check, NOT
// content validation — the client's digest verify + bounded zstd checks own
// that (see the file-top comment).
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// The untrusted sub-scope (a PR identity) is a CLIENT-supplied namespace, so
// sanitize it to one safe path segment; anything missing/invalid collapses to
// `shared` (still isolated from trusted, just not per-PR). `.` and `..` are
// rejected explicitly — the single-segment constraint already blocks a
// traversal INTO trusted, but `..` would otherwise scatter an untrusted
// write up at the bucket root (harmless but sloppy), so pin it to `shared`.
const SUBSCOPE_RE = /^[a-zA-Z0-9_.-]{1,128}$/
function subScopeOf(raw: string | null): string {
  return raw !== null && raw !== '.' && raw !== '..' && SUBSCOPE_RE.test(raw) ? raw : 'shared'
}

/** One row of `ArtifactStore.list()` — the `/v1/artifacts` surface. */
export interface ArtifactListEntry {
  hash: string
  sizeBytes: number
  /** When the artifact landed in the store (ms epoch). */
  storedAt: number
  /** Original task duration, when the backend has it cheap (local sidecar). */
  durationMs?: number
  tier: Tier
}

export class ArtifactStore {
  private readonly backend: BlobBackend
  private readonly maxBytes: number

  /**
   * A string dir builds today's local flat-dir backend (the many existing
   * call sites); a `BlobBackend` offloads raw storage (S3). `maxBytes` is
   * injectable so a test can exercise the mid-stream cap without streaming
   * 512 MiB.
   */
  constructor(dirOrBackend: string | BlobBackend, maxBytes: number = MAX_ARTIFACT_BYTES) {
    this.backend =
      typeof dirOrBackend === 'string' ? new LocalDirBackend(dirOrBackend) : dirOrBackend
    this.maxBytes = maxBytes
  }

  private key(scope: string, hash: string, ext = '.tar.zst'): string {
    return `${scope}/${hash}${ext}`
  }

  private validScope(scope: string): boolean {
    return scope.split('/').every((seg) => SEGMENT_RE.test(seg))
  }

  // A throwing backend (bucket down, credentials broken) is a LOUD 502 —
  // the client treats a non-404 as an error and degrades to a miss. A silent
  // 404-as-miss on PUT would instead let every upload "succeed" into nowhere.
  private backendError(op: string, err: unknown): Response {
    return Response.json(
      {
        error: `artifact backend ${op} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    )
  }

  private async findReadKey(hash: string, p: Principal, sub: string): Promise<string | null> {
    for (const scope of readScopes(p, sub)) {
      const key = this.key(scope, hash)
      if ((await this.backend.head(key)) !== null) return key
    }
    return null
  }

  /**
   * Existence probe across the principal's read scopes — one stat/HEAD per
   * scope. The distribution scheduler's cache prune: a submitted stable hash
   * already in a readable scope never dispatches to any agent. `sub` is the
   * untrusted per-PR partition (ignored for a trusted principal). Best-effort
   * for internal consumers: a down bucket reads as "not stored", never a
   * crashed submission (the HTTP wire stays loud — see `handle`).
   */
  async has(
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
    sub = 'shared',
  ): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false
    try {
      return (await this.findReadKey(hash, principal, sub)) !== null
    } catch {
      return false
    }
  }

  /**
   * Batch existence probe — the `POST /v1/cache/batch` primitive. Collapses N
   * client→server round-trips into ONE (the server still does per-hash HEADs,
   * but colocated with S3 and in parallel). Returns the subset of `hashes`
   * present in the principal's read scopes — resolved through the EXACT same
   * `findReadKey`/`readScopes` path a GET uses, so a batch probe can never leak
   * existence wider than a fetch could reach (trusted never sees untrusted,
   * cross-org never sees another org's key). Best-effort per hash: a down
   * bucket reads a hash as absent, never throws. Bounded fan-out so one request
   * can't flood the backend.
   */
  async hasMany(
    hashes: readonly string[],
    principal: Principal = DEFAULT_PRINCIPAL,
    sub = 'shared',
  ): Promise<Set<string>> {
    const present = new Set<string>()
    // Dedupe + drop invalid before probing.
    const unique = [...new Set(hashes)].filter((h) => HASH_RE.test(h))
    let next = 0
    const probe = async (): Promise<void> => {
      while (next < unique.length) {
        const hash = unique[next++]!
        try {
          if ((await this.findReadKey(hash, principal, sub)) !== null) present.add(hash)
        } catch {
          // down bucket → this hash reads absent (the caller re-executes)
        }
      }
    }
    const workers = Math.max(1, Math.min(HASMANY_CONCURRENCY, unique.length))
    await Promise.all(Array.from({ length: workers }, () => probe()))
    return present
  }

  /**
   * Handle one `POST /v1/cache/batch` request — the HTTP wrapper over
   * `hasMany`. Body is `{ "hashes": string[] }`; the response is
   * `{ "present": string[] }` (the subset stored in the principal's read
   * scopes). Same scope gate as `handle()`: the `x-vx-cache-scope` header
   * carries the untrusted per-PR partition, the principal is server-derived,
   * so a batch probe is trust-scoped identically to a GET.
   */
  async handleBatch(req: Request, principal: Principal = DEFAULT_PRINCIPAL): Promise<Response> {
    // Read the body with a HARD streaming cap. The server's maxRequestBodySize
    // is sized for 512 MiB artifact PUTs, so a chunked (no content-length)
    // batch body could otherwise buffer far past the tiny hash-list size —
    // abort mid-stream instead (mirrors the artifact PUT's streaming cap).
    const text = await readTextBounded(req, MAX_BATCH_BODY_BYTES)
    if (text === null) {
      return Response.json({ error: 'request body too large' }, { status: 413 })
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 })
    }
    const hashes = (body as { hashes?: unknown }).hashes
    if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string')) {
      return Response.json({ error: 'expected { hashes: string[] }' }, { status: 400 })
    }
    if (hashes.length > BATCH_HASH_CAP) {
      return Response.json(
        { error: `too many hashes (max ${BATCH_HASH_CAP} per request)` },
        { status: 400 },
      )
    }
    const sub = subScopeOf(req.headers.get('x-vx-cache-scope'))
    if (!readScopes(principal, sub).every((s) => this.validScope(s))) {
      return Response.json({ error: 'invalid scope' }, { status: 400 })
    }
    const present = await this.hasMany(hashes as string[], principal, sub)
    return Response.json({ present: [...present] })
  }

  /**
   * Original task duration (searched across read scopes), so a probe-pruned
   * task's synthesized outcome reports honest timing. Local: the `<hash>.duration`
   * sidecar file; S3: the object's user metadata.
   */
  async storedDurationMs(
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
    sub = 'shared',
  ): Promise<number | undefined> {
    if (!HASH_RE.test(hash)) return undefined
    try {
      for (const scope of readScopes(principal, sub)) {
        const local = this.backend.localPathFor(this.key(scope, hash, '.duration'))
        if (local !== null) {
          const file = Bun.file(local)
          if (!(await file.exists())) continue
          const n = Number((await file.text()).trim())
          return Number.isFinite(n) && n >= 0 ? n : undefined
        }
        const st = await this.backend.head(this.key(scope, hash))
        if (st === null) continue
        const n = Number(st.meta['durationMs'] ?? NaN)
        return Number.isFinite(n) && n >= 0 ? n : undefined
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /**
   * List the artifacts the principal may READ (`/v1/artifacts`), newest
   * first. Walks exactly `readScopes()` — the same scope set `has()`/GET
   * resolve against — so the list can never leak wider than a fetch could
   * reach: a trusted principal never sees untrusted entries, an untrusted
   * one sees its own sub-scope ∪ trusted. `subHeader` is the raw
   * `x-vx-cache-scope` header (the untrusted per-PR partition), sanitized
   * the same way `handle()` does.
   */
  async list(
    principal: Principal = DEFAULT_PRINCIPAL,
    subHeader: string | null = null,
    limit = 200,
  ): Promise<ArtifactListEntry[]> {
    const sub = subScopeOf(subHeader)
    const out: ArtifactListEntry[] = []
    // Same hash in two readable scopes (an untrusted principal's own copy
    // shadowing trusted's): keep the FIRST scope's row — readScopes is in
    // GET-resolution priority order, so the list mirrors what a fetch
    // would actually return.
    const seen = new Set<string>()
    for (const { scope, tier } of readScopeSpecs(principal, sub)) {
      if (!this.validScope(scope)) continue
      let blobs: BlobListEntry[]
      try {
        blobs = await this.backend.list(scope)
      } catch {
        continue // a down bucket lists empty — the wire GET/HEAD stay loud
      }
      for (const b of blobs) {
        const name = b.key.slice(scope.length + 1)
        if (!name.endsWith('.tar.zst')) continue
        const hash = name.slice(0, -'.tar.zst'.length)
        if (!HASH_RE.test(hash) || seen.has(hash)) continue
        seen.add(hash)
        const entry: ArtifactListEntry = {
          hash,
          sizeBytes: b.size,
          storedAt: b.storedAt,
          tier,
        }
        if (b.durationMs !== undefined) entry.durationMs = b.durationMs
        out.push(entry)
      }
    }
    out.sort((a, b) => b.storedAt - a.storedAt)
    return out.slice(0, Math.max(0, limit))
  }

  /**
   * Handle one `/v1/cache/:hash` request (HEAD / GET / PUT) for a given
   * authenticated principal. Routing is by the principal's server-derived
   * scope, never a client claim.
   */
  async handle(
    req: Request,
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
  ): Promise<Response> {
    if (!HASH_RE.test(hash)) {
      return Response.json({ error: 'invalid artifact hash' }, { status: 400 })
    }
    // The untrusted per-PR partition — a client-supplied `x-vx-cache-scope`
    // header (a PR identity). Sanitized to one safe segment; ignored for a
    // trusted principal (trusted is flat).
    const sub = subScopeOf(req.headers.get('x-vx-cache-scope'))
    const wScope = writeScope(principal, sub)
    const rScopes = readScopes(principal, sub)
    if (!this.validScope(wScope) || !rScopes.every((s) => this.validScope(s))) {
      return Response.json({ error: 'invalid scope' }, { status: 400 })
    }

    if (req.method === 'HEAD') {
      try {
        const found = await this.findReadKey(hash, principal, sub)
        return new Response(null, { status: found !== null ? 200 : 404 })
      } catch (err) {
        return this.backendError('HEAD', err)
      }
    }

    if (req.method === 'GET') {
      // Single-read-scope fast path on an offloaded (presigning) backend: the
      // per-scope existence HEAD exists to pick WHICH readable scope's key to
      // presign, so with exactly ONE scope it decides nothing — the presigned
      // URL binds the principal's own server-derived scope key either way.
      // Skip it: one S3 round-trip saved per GET on the hottest surface (a
      // distributed build issues thousands). WIRE CONSEQUENCE (deliberate): a
      // single-scope GET of an ABSENT hash now answers 307 — the bucket then
      // 404s and the client treats a post-307 404 as a cache miss (pinned in
      // native-cache.test.ts) — instead of a serve-side 404; the end-to-end
      // outcome is identical, the round-trip moves off the serve. (A
      // strict-ACL bucket that answers 403 for an absent key — AWS without
      // s3:ListBucket — makes the client THROW instead, which LayeredCache
      // also degrades to a miss; never a wrong hit either way.) Multi-scope
      // principals (untrusted: own sub-scope ∪ trusted) keep the
      // HEAD-per-scope resolution below — there the HEAD is what decides
      // which scope's key wins.
      if (rScopes.length === 1) {
        const soleKey = this.key(rScopes[0]!, hash)
        if (this.backend.localPathFor(soleKey) === null) {
          try {
            const target = await this.backend.presignGet(soleKey)
            if (target !== null) {
              return new Response(null, { status: 307, headers: { Location: target } })
            }
            // A backend with neither a local path nor a presigner: fall
            // through to the resolving path (absent → 404, present → 502 —
            // exactly the pre-fast-path behavior).
          } catch (err) {
            return this.backendError('GET', err)
          }
        }
      }
      let found: string | null
      try {
        found = await this.findReadKey(hash, principal, sub)
      } catch (err) {
        return this.backendError('GET', err)
      }
      if (found === null) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      const local = this.backend.localPathFor(found)
      if (local !== null) {
        // Sidecars live beside the artifact in the SAME scope it was found in.
        const scopeDir = path.dirname(local)
        const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
        const durationFile = Bun.file(path.join(scopeDir, `${hash}.duration`))
        if (await durationFile.exists()) {
          headers['x-vx-duration-ms'] = (await durationFile.text()).trim()
        }
        const digestFile = Bun.file(path.join(scopeDir, `${hash}.digest`))
        if (await digestFile.exists()) {
          headers['x-vx-digest'] = (await digestFile.text()).trim()
        }
        // Bun.file responses stream with the Content-Length set from the file
        // size — exactly the contract the client's bounded body read relies on.
        return new Response(Bun.file(local), { headers })
      }
      // Offloaded storage: redirect to a short-lived pre-signed bucket URL —
      // the controller never proxies a download. The client follows exactly
      // one hop, dropping the bearer + scope header cross-origin; the wire
      // metadata rides back as the object's `x-amz-meta-vx-*` user metadata.
      try {
        const target = await this.backend.presignGet(found)
        if (target === null) {
          return Response.json({ error: 'artifact backend cannot serve bytes' }, { status: 502 })
        }
        return new Response(null, { status: 307, headers: { Location: target } })
      } catch (err) {
        return this.backendError('GET', err)
      }
    }

    if (req.method === 'PUT') {
      const declared = Number(req.headers.get('content-length') ?? '0')
      if (declared > this.maxBytes) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      const key = this.key(wScope, hash)
      // Immutability: never overwrite an existing artifact. A content-addressed
      // key genuinely re-derived produces byte-equal bytes, so a re-PUT is a
      // no-op at best and a poisoning overwrite at worst — refuse it. This
      // stops an authenticated writer from replacing a legitimate entry.
      // Checked BEFORE reading the body, so a duplicate upload costs nothing.
      // (On S3 the HEAD-then-PUT race is benign: equal bytes, atomic PUT.)
      try {
        if ((await this.backend.head(key)) !== null) {
          return Response.json({ ok: true, immutable: true }, { status: 409 })
        }
      } catch (err) {
        return this.backendError('PUT', err)
      }
      // STREAMING write to a spool file — never buffer the body in RAM. The
      // byte cap is enforced on ACTUAL cumulative bytes mid-stream (a chunked
      // body with no/false content-length can't defeat it). The spool
      // colocates with a local destination so the backend's rename is atomic
      // (a concurrent GET never sees a torn artifact); on an offloaded
      // backend it's transit-only in the OS tmpdir.
      const localDest = this.backend.localPathFor(key)
      const spoolTag = `tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      let spool: string
      if (localDest !== null) {
        await mkdir(path.dirname(localDest), { recursive: true })
        spool = `${localDest}.${spoolTag}`
      } else {
        spool = path.join(os.tmpdir(), `vx-blob-spool-${spoolTag}`)
      }
      let overCap = false
      let total = 0
      const head: number[] = []
      try {
        const writer = Bun.file(spool).writer()
        try {
          const reader = req.body?.getReader()
          if (reader !== undefined) {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value === undefined) continue
              if (head.length < ZSTD_MAGIC.length) {
                for (const b of value.subarray(0, ZSTD_MAGIC.length - head.length)) head.push(b)
              }
              total += value.byteLength
              if (total > this.maxBytes) {
                await reader.cancel().catch(() => {})
                overCap = true
                break
              }
              await writer.write(value)
            }
          }
        } finally {
          await writer.end()
        }
        if (overCap) {
          return Response.json({ error: 'artifact too large' }, { status: 413 })
        }
        // Refuse an empty/non-zstd body BEFORE it becomes an immutable entry —
        // otherwise a junk upload would lock this key forever (see ZSTD_MAGIC).
        if (head.length < ZSTD_MAGIC.length || !ZSTD_MAGIC.every((b, i) => head[i] === b)) {
          return Response.json(
            { error: 'invalid artifact body (not a zstd frame)' },
            { status: 400 },
          )
        }
        // Metadata validation is policy, so it stays here: the backend stores
        // whatever it's handed. The digest is stored, not verified — the
        // client verifies it against the bytes it receives on GET.
        const meta: Record<string, string> = {}
        const duration = req.headers.get('x-vx-duration-ms')
        if (duration !== null && /^\d+$/.test(duration)) meta['durationMs'] = duration
        const digest = req.headers.get('x-vx-digest')
        if (digest !== null && /^xxh3:[0-9a-f]{1,16}$/.test(digest)) meta['digest'] = digest
        await this.backend.put(key, spool, total, meta)
      } catch (err) {
        await unlink(spool).catch(() => {})
        return this.backendError('PUT', err)
      } finally {
        // The local backend's put RENAMES the spool away; every other path
        // (S3 upload, over-cap, magic-reject) leaves it — nothing rests on
        // the controller.
        await unlink(spool).catch(() => {})
      }
      return Response.json({ ok: true })
    }

    return Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { Allow: 'GET, HEAD, PUT' } },
    )
  }
}
