// The serve-hosted artifact store — the vx-native `/v1/cache/:hash` wire
// (docs/design/native-cache-wire-2026-07.md; the Turbo `/v8/artifacts`
// surface is gone). Backing is a flat dir of `<hash>.tar.zst` files per
// scope under the ingest root: the artifact IS the local cache's own
// on-disk format, shipped verbatim, so the store needs no unpacking, no
// index, no schema — deliberately trivial dir I/O rather than an import of
// core's internal CAS seam (core internals stay internal).
//
// Wire metadata rides two sidecars: `<hash>.duration` (the producing
// task's duration, `x-vx-duration-ms` on the wire) and `<hash>.digest`
// (`x-vx-digest`, `xxh3:<hex>` over the artifact bytes). The digest is
// stored and echoed back on GET but NOT verified server-side — the CLIENT
// verifies it against the received bytes, which covers the corruption
// directions that matter (a corrupt store or a truncating transport
// degrade to a cache miss at the consumer, never a restored artifact).
//
// TRUST SCOPES (docs/design/cache-trust-scopes-2026-07.md). The store is
// partitioned by `<bucket>/<tier>`, both SERVER-DERIVED from the presented
// token — never client-supplied. The tier boundary is the fork-PR CVE-class
// fix: an `untrusted` writer (a fork-PR CI job) can write only the
// `untrusted` scope and read `untrusted` ∪ `trusted`; a `trusted` writer
// (protected branch) writes and reads only `trusted`. So a poisoned artifact
// an untrusted context places NEVER feeds a trusted build, and an untrusted
// context can NEVER write into the trusted scope — no matter what cache key
// it computes. Solo-dev / single-token deployments are all `default/trusted`
// (the legacy flat store migrates there on boot), byte-identical to before.

import path from 'node:path'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'

/** PUT bodies above this are refused with 413. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export type Tier = 'trusted' | 'untrusted'

/**
 * The authenticated identity of a request, derived server-side from its
 * token. `bucket` is `default` in Phase 1 (a per-workspace bucket is the
 * hosted-multi-tenant Phase 2). Never carries a client-declared value.
 */
export interface Principal {
  tier: Tier
  bucket: string
}

/** The default principal for an open (tokenless) or single-token serve. */
export const DEFAULT_PRINCIPAL: Principal = { tier: 'trusted', bucket: 'default' }

// The hash becomes a filename — accept only a safe path token so a hostile
// hash can't traverse out of the store dir. (vx hashes are 16-hex; the wider
// token keeps other RemoteCacheLayer implementations working.)
const HASH_RE = /^[a-zA-Z0-9_-]{1,128}$/
// Scope segments are server-derived, but validate them anyway (defense in
// depth) so a future bug that lets a value flow from the wire can't traverse.
const SEGMENT_RE = /^[a-zA-Z0-9_.-]{1,128}$/

/**
 * Scopes a principal may READ, in priority order. An untrusted context reads
 * its own scope first, then falls through to the trusted baseline (so PRs are
 * warm off `main`); a trusted context reads only trusted — it NEVER consumes
 * an untrusted (poisonable) artifact.
 */
function readScopes(p: Principal, sub: string): string[] {
  // Untrusted reads ITS OWN sub-scope (a per-PR partition) + the trusted
  // baseline — NEVER another PR's untrusted scope. So one fork PR can neither
  // read nor poison another's cache; the blast radius of an untrusted write is
  // exactly one PR, and trusted is never consumed.
  return p.tier === 'untrusted'
    ? [`${p.bucket}/untrusted/${sub}`, `${p.bucket}/trusted`]
    : [`${p.bucket}/trusted`]
}

/** The single scope a principal WRITES: trusted is flat; untrusted is
 *  per-PR-partitioned so PRs never write into each other's scope. */
function writeScope(p: Principal, sub: string): string {
  return p.tier === 'untrusted' ? `${p.bucket}/untrusted/${sub}` : `${p.bucket}/trusted`
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
  /** File mtime (ms epoch) — when the artifact landed in the store. */
  storedAt: number
  /** Original task duration from the `.duration` sidecar, when present. */
  durationMs?: number
  tier: Tier
}

export class ArtifactStore {
  /** `maxBytes` is injectable so a test can exercise the mid-stream cap
   *  without streaming 512 MiB. */
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number = MAX_ARTIFACT_BYTES,
  ) {}

  private scopedPath(scope: string, hash: string, ext: string): string {
    return path.join(this.dir, scope, `${hash}${ext}`)
  }

  private validScope(scope: string): boolean {
    return scope.split('/').every((seg) => SEGMENT_RE.test(seg))
  }

  /**
   * Move a legacy flat store (`<dir>/<hash>.tar.zst` + sidecars, written
   * before trust scopes) into `default/trusted/`. Idempotent, best-effort,
   * loud — run once on boot so existing single-tenant deployments keep their
   * warm cache and their single token maps to `trusted`.
   */
  async migrateLegacyFlatStore(log?: (m: string) => void): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return // no store dir yet — nothing to migrate
    }
    const legacy = names.filter((n) => /\.(tar\.zst|tag|duration)$/.test(n))
    if (legacy.length === 0) return
    const destDir = path.join(this.dir, 'default', 'trusted')
    await mkdir(destDir, { recursive: true })
    let moved = 0
    for (const n of legacy) {
      try {
        await rename(path.join(this.dir, n), path.join(destDir, n))
        moved++
      } catch {
        // a dir entry (e.g. `default`) or a race — skip
      }
    }
    if (moved > 0) log?.(`migrated ${moved} flat artifact file(s) → default/trusted/`)
  }

  private async findRead(
    hash: string,
    p: Principal,
    sub: string,
    ext: string,
  ): Promise<string | null> {
    for (const scope of readScopes(p, sub)) {
      const file = this.scopedPath(scope, hash, ext)
      if (await Bun.file(file).exists()) return file
    }
    return null
  }

  /**
   * Existence probe across the principal's read scopes — one stat per scope.
   * The distribution scheduler's cache prune: a submitted stable hash already
   * in a readable scope never dispatches to any agent. `sub` is the untrusted
   * per-PR partition (ignored for a trusted principal).
   */
  async has(
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
    sub = 'shared',
  ): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false
    return (await this.findRead(hash, principal, sub, '.tar.zst')) !== null
  }

  /**
   * Original task duration from the `<hash>.duration` sidecar (searched across
   * read scopes), so a probe-pruned task's synthesized outcome reports honest
   * timing.
   */
  async storedDurationMs(
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
    sub = 'shared',
  ): Promise<number | undefined> {
    if (!HASH_RE.test(hash)) return undefined
    const file = await this.findRead(hash, principal, sub, '.duration')
    if (file === null) return undefined
    const n = Number((await Bun.file(file).text()).trim())
    return Number.isFinite(n) && n >= 0 ? n : undefined
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
    for (const scope of readScopes(principal, sub)) {
      if (!this.validScope(scope)) continue
      const scopeDir = path.join(this.dir, scope)
      let names: string[]
      try {
        names = await readdir(scopeDir)
      } catch {
        continue // scope dir doesn't exist yet — nothing stored there
      }
      const tier: Tier = scope.split('/')[1] === 'untrusted' ? 'untrusted' : 'trusted'
      for (const n of names) {
        if (!n.endsWith('.tar.zst')) continue
        const hash = n.slice(0, -'.tar.zst'.length)
        if (!HASH_RE.test(hash) || seen.has(hash)) continue
        seen.add(hash)
        let st: Awaited<ReturnType<typeof stat>>
        try {
          st = await stat(path.join(scopeDir, n))
        } catch {
          continue // raced with a prune — skip
        }
        const entry: ArtifactListEntry = {
          hash,
          sizeBytes: st.size,
          storedAt: Math.round(st.mtimeMs),
          tier,
        }
        const durationFile = Bun.file(path.join(scopeDir, `${hash}.duration`))
        if (await durationFile.exists()) {
          const d = Number((await durationFile.text()).trim())
          if (Number.isFinite(d) && d >= 0) entry.durationMs = d
        }
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
    if (!this.validScope(wScope) || !readScopes(principal, sub).every((s) => this.validScope(s))) {
      return Response.json({ error: 'invalid scope' }, { status: 400 })
    }

    if (req.method === 'HEAD') {
      const found = await this.findRead(hash, principal, sub, '.tar.zst')
      return new Response(null, { status: found !== null ? 200 : 404 })
    }

    if (req.method === 'GET') {
      const found = await this.findRead(hash, principal, sub, '.tar.zst')
      if (found === null) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      // Sidecars live beside the artifact in the SAME scope it was found in.
      const scopeDir = path.dirname(found)
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
      return new Response(Bun.file(found), { headers })
    }

    if (req.method === 'PUT') {
      const declared = Number(req.headers.get('content-length') ?? '0')
      if (declared > this.maxBytes) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      const artifactPath = this.scopedPath(wScope, hash, '.tar.zst')
      // Immutability: never overwrite an existing artifact. A content-addressed
      // key genuinely re-derived produces byte-equal bytes, so a re-PUT is a
      // no-op at best and a poisoning overwrite at worst — refuse it. This
      // stops an authenticated writer from replacing a legitimate entry.
      // Checked BEFORE reading the body, so a duplicate upload costs nothing.
      if (await Bun.file(artifactPath).exists()) {
        return Response.json({ ok: true, immutable: true }, { status: 409 })
      }
      const scopeDir = path.join(this.dir, wScope)
      await mkdir(scopeDir, { recursive: true })
      // STREAMING write to a temp file — never buffer the body in RAM. The
      // byte cap is enforced on ACTUAL cumulative bytes mid-stream (a chunked
      // body with no/false content-length can't defeat it), and the atomic
      // tmp+rename keeps a concurrent GET from ever seeing a torn artifact.
      const tmp = `${artifactPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      let overCap = false
      const head: number[] = []
      try {
        const writer = Bun.file(tmp).writer()
        let total = 0
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
          await unlink(tmp).catch(() => {})
          return Response.json({ error: 'artifact too large' }, { status: 413 })
        }
        // Refuse an empty/non-zstd body BEFORE it becomes an immutable entry —
        // otherwise a junk upload would lock this key forever (see ZSTD_MAGIC).
        if (head.length < ZSTD_MAGIC.length || !ZSTD_MAGIC.every((b, i) => head[i] === b)) {
          await unlink(tmp).catch(() => {})
          return Response.json(
            { error: 'invalid artifact body (not a zstd frame)' },
            { status: 400 },
          )
        }
        await rename(tmp, artifactPath)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      const duration = req.headers.get('x-vx-duration-ms')
      if (duration !== null && /^\d+$/.test(duration)) {
        await Bun.write(path.join(scopeDir, `${hash}.duration`), duration)
      }
      // Stored, not verified: the client verifies the digest against the
      // bytes it receives on GET (see the file-top comment).
      const digest = req.headers.get('x-vx-digest')
      if (digest !== null && /^xxh3:[0-9a-f]{1,16}$/.test(digest)) {
        await Bun.write(path.join(scopeDir, `${hash}.digest`), digest)
      }
      return Response.json({ ok: true })
    }

    return Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { Allow: 'GET, HEAD, PUT' } },
    )
  }
}
