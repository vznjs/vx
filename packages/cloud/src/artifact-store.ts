// The serve-hosted artifact store — the Turbo `/v8/artifacts/:hash` wire
// core's RemoteCache already speaks (client and server meet on the same
// spec, so any Turbo-compatible client works too). Backing is a flat dir of
// `<hash>.tar.zst` files per scope under the ingest root: the artifact IS the
// local cache's own on-disk format, shipped verbatim, so the store needs no
// unpacking, no index, no schema — deliberately trivial dir I/O rather than
// an import of core's internal CAS seam (core internals stay internal).
//
// Signing (`x-artifact-tag`) is CLIENT-side end-to-end: a PUT's tag is kept
// in a `<hash>.tag` sidecar and returned on GET so verifying clients can
// check it; the server itself never signs or verifies.
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
import { mkdir, readdir, rename, unlink } from 'node:fs/promises'

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
// hash can't traverse out of the store dir. (vx hashes are 16-hex; Turbo's
// are 16-hex too; the wider token keeps other clients working.)
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
function readScopes(p: Principal): string[] {
  return p.tier === 'untrusted'
    ? [`${p.bucket}/untrusted`, `${p.bucket}/trusted`]
    : [`${p.bucket}/trusted`]
}

/** The single scope a principal WRITES: its own bucket + tier. */
function writeScope(p: Principal): string {
  return `${p.bucket}/${p.tier}`
}

export class ArtifactStore {
  constructor(private readonly dir: string) {}

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

  private async findRead(hash: string, p: Principal, ext: string): Promise<string | null> {
    for (const scope of readScopes(p)) {
      const file = this.scopedPath(scope, hash, ext)
      if (await Bun.file(file).exists()) return file
    }
    return null
  }

  /**
   * Existence probe across the principal's read scopes — one stat per scope.
   * The distribution scheduler's cache prune: a submitted stable hash already
   * in a readable scope never dispatches to any agent.
   */
  async has(hash: string, principal: Principal = DEFAULT_PRINCIPAL): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false
    return (await this.findRead(hash, principal, '.tar.zst')) !== null
  }

  /**
   * Original task duration from the `<hash>.duration` sidecar (searched across
   * read scopes), so a probe-pruned task's synthesized outcome reports honest
   * timing.
   */
  async storedDurationMs(
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
  ): Promise<number | undefined> {
    if (!HASH_RE.test(hash)) return undefined
    const file = await this.findRead(hash, principal, '.duration')
    if (file === null) return undefined
    const n = Number((await Bun.file(file).text()).trim())
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }

  /**
   * Handle one `/v8/artifacts/:hash` request (HEAD / GET / PUT) for a given
   * authenticated principal. The optional `?teamId=` / `?slug=` tenancy params
   * Turbo clients send are accepted by ignoring them — routing is by the
   * principal's server-derived scope, not a client claim.
   */
  async handle(
    req: Request,
    hash: string,
    principal: Principal = DEFAULT_PRINCIPAL,
  ): Promise<Response> {
    if (!HASH_RE.test(hash)) {
      return Response.json({ error: 'invalid artifact hash' }, { status: 400 })
    }
    const wScope = writeScope(principal)
    if (!this.validScope(wScope) || !readScopes(principal).every((s) => this.validScope(s))) {
      return Response.json({ error: 'invalid scope' }, { status: 400 })
    }

    if (req.method === 'HEAD') {
      const found = await this.findRead(hash, principal, '.tar.zst')
      return new Response(null, { status: found !== null ? 200 : 404 })
    }

    if (req.method === 'GET') {
      const found = await this.findRead(hash, principal, '.tar.zst')
      if (found === null) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      // Sidecars live beside the artifact in the SAME scope it was found in.
      const scopeDir = path.dirname(found)
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
      const tagFile = Bun.file(path.join(scopeDir, `${hash}.tag`))
      if (await tagFile.exists()) headers['x-artifact-tag'] = (await tagFile.text()).trim()
      const durationFile = Bun.file(path.join(scopeDir, `${hash}.duration`))
      if (await durationFile.exists()) {
        headers['x-artifact-duration'] = (await durationFile.text()).trim()
      }
      // Bun.file responses stream with the Content-Length set from the file
      // size — exactly the contract RemoteCache's body read relies on.
      return new Response(Bun.file(found), { headers })
    }

    if (req.method === 'PUT') {
      const declared = Number(req.headers.get('content-length') ?? '0')
      if (declared > MAX_ARTIFACT_BYTES) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      const artifactPath = this.scopedPath(wScope, hash, '.tar.zst')
      // Immutability: never overwrite an existing artifact. A content-addressed
      // key genuinely re-derived produces byte-equal bytes, so a re-PUT is a
      // no-op at best and a poisoning overwrite at worst — refuse it. This
      // stops an authenticated writer from replacing a legitimate entry.
      if (await Bun.file(artifactPath).exists()) {
        return Response.json({ ok: true, immutable: true }, { status: 409 })
      }
      const body = new Uint8Array(await req.arrayBuffer())
      if (body.byteLength > MAX_ARTIFACT_BYTES) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      const scopeDir = path.join(this.dir, wScope)
      await mkdir(scopeDir, { recursive: true })
      // Atomic write: a concurrent GET must never see a torn artifact, and a
      // crashed PUT must leave no half-written `<hash>.tar.zst` behind.
      const tmp = `${artifactPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      try {
        await Bun.write(tmp, body)
        await rename(tmp, artifactPath)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      const tag = req.headers.get('x-artifact-tag')
      if (tag !== null) await Bun.write(path.join(scopeDir, `${hash}.tag`), tag)
      const duration = req.headers.get('x-artifact-duration')
      if (duration !== null && /^\d+$/.test(duration)) {
        await Bun.write(path.join(scopeDir, `${hash}.duration`), duration)
      }
      return Response.json({ urls: [] })
    }

    return Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { Allow: 'GET, HEAD, PUT' } },
    )
  }
}
