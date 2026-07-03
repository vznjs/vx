// The serve-hosted artifact store — the Turbo `/v8/artifacts/:hash` wire
// core's RemoteCache already speaks (client and server meet on the same
// spec, so any Turbo-compatible client works too). Backing is a flat dir of
// `<hash>.tar.zst` files under the ingest root: the artifact IS the local
// cache's own on-disk format, shipped verbatim, so the store needs no
// unpacking, no index, no schema — deliberately trivial dir I/O rather than
// an import of core's internal CAS seam (core internals stay internal).
//
// Signing (`x-artifact-tag`) is CLIENT-side end-to-end: a PUT's tag is kept
// in a `<hash>.tag` sidecar and returned on GET so verifying clients can
// check it; the server itself never signs or verifies.

import path from 'node:path'
import { mkdir, rename, unlink } from 'node:fs/promises'

/** PUT bodies above this are refused with 413. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

// The hash becomes a filename — accept only a safe path token so a hostile
// hash can't traverse out of the store dir. (vx hashes are 16-hex; Turbo's
// are 16-hex too; the wider token keeps other clients working.)
const HASH_RE = /^[a-zA-Z0-9_-]{1,128}$/

export class ArtifactStore {
  constructor(private readonly dir: string) {}

  private artifactPath(hash: string): string {
    return path.join(this.dir, `${hash}.tar.zst`)
  }

  private tagPath(hash: string): string {
    return path.join(this.dir, `${hash}.tag`)
  }

  private durationPath(hash: string): string {
    return path.join(this.dir, `${hash}.duration`)
  }

  /**
   * Existence probe — one stat on local disk. The distribution scheduler's
   * cache prune: a submitted stable hash that's already in the store never
   * dispatches to any agent.
   */
  async has(hash: string): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false
    return await Bun.file(this.artifactPath(hash)).exists()
  }

  /**
   * Original task duration from the `<hash>.duration` sidecar, so a
   * probe-pruned task's synthesized outcome reports honest timing.
   */
  async storedDurationMs(hash: string): Promise<number | undefined> {
    if (!HASH_RE.test(hash)) return undefined
    const file = Bun.file(this.durationPath(hash))
    if (!(await file.exists())) return undefined
    const n = Number((await file.text()).trim())
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }

  /**
   * Handle one `/v8/artifacts/:hash` request (HEAD / GET / PUT). The
   * optional `?teamId=` / `?slug=` tenancy params Turbo clients send are
   * accepted by ignoring them — this store is single-tenant, one bearer per
   * server (workspaces are namespaces, not security boundaries).
   */
  async handle(req: Request, hash: string): Promise<Response> {
    if (!HASH_RE.test(hash)) {
      return Response.json({ error: 'invalid artifact hash' }, { status: 400 })
    }
    const file = Bun.file(this.artifactPath(hash))

    if (req.method === 'HEAD') {
      return new Response(null, { status: (await file.exists()) ? 200 : 404 })
    }

    if (req.method === 'GET') {
      if (!(await file.exists())) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
      const tagFile = Bun.file(this.tagPath(hash))
      if (await tagFile.exists()) headers['x-artifact-tag'] = (await tagFile.text()).trim()
      // Original task duration, so a remote hit records honest analytics on
      // the restoring machine instead of durationMs 0.
      const durationFile = Bun.file(this.durationPath(hash))
      if (await durationFile.exists()) {
        headers['x-artifact-duration'] = (await durationFile.text()).trim()
      }
      // Bun.file responses stream with the Content-Length set from the file
      // size — exactly the contract RemoteCache's body read relies on.
      return new Response(file, { headers })
    }

    if (req.method === 'PUT') {
      const declared = Number(req.headers.get('content-length') ?? '0')
      if (declared > MAX_ARTIFACT_BYTES) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      const body = new Uint8Array(await req.arrayBuffer())
      if (body.byteLength > MAX_ARTIFACT_BYTES) {
        return Response.json({ error: 'artifact too large' }, { status: 413 })
      }
      await mkdir(this.dir, { recursive: true })
      // Atomic write: a concurrent GET must never see a torn artifact, and a
      // crashed PUT must leave no half-written `<hash>.tar.zst` behind.
      const tmp = `${this.artifactPath(hash)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      try {
        await Bun.write(tmp, body)
        await rename(tmp, this.artifactPath(hash))
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      const tag = req.headers.get('x-artifact-tag')
      if (tag !== null) await Bun.write(this.tagPath(hash), tag)
      const duration = req.headers.get('x-artifact-duration')
      if (duration !== null && /^\d+$/.test(duration)) {
        await Bun.write(this.durationPath(hash), duration)
      }
      return Response.json({ urls: [] })
    }

    return Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { Allow: 'GET, HEAD, PUT' } },
    )
  }
}
