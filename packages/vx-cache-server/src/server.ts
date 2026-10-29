// vx-cache v1 (PROTOCOL.md) over any `Blobs` bucket: one fetch handler
// the Bun server, the Worker and the Docker image all serve. No database:
// an artifact is one object, named by its issuer, repository name, scope and
// hash, and a read names the exact scope it wants (2026-10-25).

import {
  type Access,
  type Authorize,
  errorJson,
  hashPart,
  notAllowed,
  Refusal,
} from '@vzn/vx-devtools'
import { isCount, isHash, LIMIT_HEADERS, SCOPE_HEADER } from './protocol.js'
import { blobName, type Blobs } from './store.js'

/** What an operator may set; each defaults, and a backend may cap them. */
export interface Limits {
  /** The lookups one check makes: its hashes times its scopes. */
  readonly maxCheckHashes: number
  /** The largest upload, in bytes: one artifact. */
  readonly maxUploadBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  maxCheckHashes: 500,
  maxUploadBytes: 100_000_000,
}

export interface ServerOptions {
  blobs: Blobs
  authorize: Authorize
  limits?: Partial<Limits>
}

const VARS = {
  maxCheckHashes: 'MAX_CHECK_HASHES',
  maxUploadBytes: 'MAX_UPLOAD_BYTES',
} as const

/**
 * `MAX_CHECK_HASHES` and `MAX_UPLOAD_BYTES` from the environment, each a
 * whole number above 0: a string, or a number as wrangler.jsonc may write
 * it (a number was skipped, unsaid, for the default).
 */
export function limitsFrom(env: object): Partial<Limits> {
  const out: Partial<Record<keyof Limits, number>> = {}
  for (const [field, name] of Object.entries(VARS) as [keyof Limits, string][]) {
    const v = (env as Record<string, unknown>)[name]
    if (v === undefined || v === '') continue
    // A Worker var may be JSON: a number was skipped, the default served.
    // A string is digits only, as --port is: Number read 0x10 as 16.
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN
    if (!(Number.isSafeInteger(n) && n > 0))
      throw new Error(
        `${name}: not a whole number above 0: ${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`,
      )
    out[field] = n
  }
  return out
}

/** A held artifact's bytes never change (2026-10-25). */
const IMMUTABLE = 'private, max-age=31536000, immutable'

/** A scope on the wire: its ref's `hashPart`, so no ref is ever sent or stored plain (2026-10-25). */
const SCOPE = /^[0-9a-f]{32}$/

export function createCacheServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { blobs, authorize } = opts
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits }
  const limitHeaders = Object.fromEntries(
    Object.entries(LIMIT_HEADERS).map(([k, h]) => [h, String(limits[k as keyof Limits])]),
  )

  /** The scope a client names: a ref's hash, read as it is. */
  const scopeOf = (scope: unknown): string => {
    if (typeof scope !== 'string' || !SCOPE.test(scope)) {
      throw new Refusal(400, "scope: a ref's hash, 32 hex digits (PROTOCOL.md § Keys)")
    }
    return scope
  }
  const nameOf = (access: Access, scope: string, hash: string): Promise<string> =>
    blobName(access.issuer, access.repository, scope, hash)
  /** A read of the bucket: one it fails is its fault, `502`, never the server's `500`. */
  const read = async <T>(ask: Promise<T>): Promise<T> => {
    try {
      return await ask
    } catch (err) {
      throw new Refusal(502, `the bucket could not be read: ${message(err)}`)
    }
  }

  /** The token's own scope, the one place it writes. */
  const writeScope = (access: Access): Promise<string> => {
    if (access.write === undefined) throw new Refusal(403, 'this request reads only')
    return hashPart(access.write)
  }

  /**
   * `{ hashes, scopes }`: Turbo's batch query, with the scopes to read in
   * the order to read them; up to `max` lookups, hashes times scopes.
   */
  async function queryOf(req: Request, max: number) {
    const body = await readJson(req, max * 140 + 100)
    const hashes = field(body, 'hashes')
    const scopes = field(body, 'scopes')
    if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && isHash(h))) {
      throw new Refusal(400, 'hashes: a list of 1 to 128 hex digits each')
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new Refusal(400, "scopes: a list of refs' hashes, in the order to read them")
    }
    if (hashes.length * scopes.length > max) {
      throw new Refusal(400, `hashes × scopes: up to ${max} lookups`)
    }
    return { hashes: hashes as string[], scopes: scopes.map(scopeOf) }
  }

  async function artifact(req: Request, hash: string): Promise<Response> {
    if (!isHash(hash)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    const scope = scopeOf(req.headers.get(SCOPE_HEADER))
    const blob = await read(blobs.get(await nameOf(access, scope, hash)))
    if (blob === null) return errorJson(404, 'no artifact under this key')
    return new Response(blob.body, {
      headers: {
        'content-length': String(blob.size),
        'content-type': 'application/octet-stream',
        // An artifact never changes under its key; private: its token chose the repository.
        'cache-control': IMMUTABLE,
      },
    })
  }

  /** Turbo's `HEAD /v8/artifacts/<hash>`: whether the scope named holds it, and its size, with no bytes. */
  async function exists(req: Request, hash: string): Promise<Response> {
    if (!isHash(hash)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    const scope = scopeOf(req.headers.get(SCOPE_HEADER))
    const size = await read(blobs.size(await nameOf(access, scope, hash)))
    if (size === null) return new Response(null, { status: 404 })
    return new Response(null, {
      headers: { 'content-length': String(size), 'cache-control': IMMUTABLE },
    })
  }

  // Every lookup at once, each exact: a hash answers the first scope
  // asked that holds it, and names it, for the download to read.
  async function check(req: Request): Promise<Response> {
    const access = await authorize(req)
    const { hashes, scopes } = await queryOf(req, limits.maxCheckHashes)
    const sizes = await Promise.all(
      hashes.map((hash) =>
        Promise.all(scopes.map(async (s) => read(blobs.size(await nameOf(access, s, hash))))),
      ),
    )
    const held = Object.fromEntries(
      hashes.map((hash, i) => {
        const at = sizes[i]!.findIndex((size) => size !== null)
        return [hash, at < 0 ? null : { size: sizes[i]![at], scope: scopes[at] }]
      }),
    )
    return Response.json(held)
  }

  /**
   * An upload: one artifact, its bytes the whole body (Turbo's
   * `PUT /v8/artifacts/<hash>`), stored in the token's scope. They reach
   * the bucket without passing through this code, so a large one costs
   * no CPU here (2026-10-25: no batch upload; a batch is split by this
   * code, and on Workers a 40 MB one ran out of CPU).
   */
  async function put(req: Request, hash: string): Promise<Response> {
    if (!isHash(hash)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    const name = await nameOf(access, await writeScope(access), hash)
    const length = contentLength(req)
    if (length > limits.maxUploadBytes) {
      throw new Refusal(413, `an upload is at most ${limits.maxUploadBytes} bytes`)
    }
    if ((await read(blobs.size(name))) !== null) {
      await req.body?.cancel()
      return new Response(null, { status: 204 })
    }
    try {
      await blobs.put(name, req.body ?? new Blob([]).stream(), length)
    } catch (err) {
      if (err instanceof Refusal) throw err
      throw new Refusal(502, `the bucket refused the artifact: ${message(err)}`)
    }
    return new Response(null, { status: 204 })
  }

  return async (req) => {
    const res = await answer(req)
    // Every /v1/artifacts answer, a refusal too: a client holding older
    // limits (a restart with new ones, a Worker's rollout) learns them from
    // the answer that refused it, or it was refused every check of the run.
    if (/^\/v1\/artifacts(\/|$)/.test(new URL(req.url).pathname))
      for (const [h, v] of Object.entries(limitHeaders)) res.headers.set(h, v)
    return res
  }

  async function answer(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      const path = url.pathname
      // Turbo's team params are not taken: a repository is its token's.
      if (url.searchParams.has('teamId') || url.searchParams.has('slug')) {
        throw new Refusal(400, 'teamId and slug are not taken: the token names the repository')
      }
      if (path === '/v1/capabilities') {
        if (req.method !== 'GET') return notAllowed('GET')
        await authorize(req)
        return Response.json(limits)
      }
      if (path === '/v1/artifacts') {
        return req.method === 'POST' ? await check(req) : notAllowed('POST')
      }
      if (path.startsWith('/v1/artifacts/') && !path.slice('/v1/artifacts/'.length).includes('/')) {
        const hash = path.slice('/v1/artifacts/'.length)
        if (req.method === 'GET') return await artifact(req, hash)
        if (req.method === 'HEAD') return await exists(req, hash)
        return req.method === 'PUT' ? await put(req, hash) : notAllowed('GET, HEAD, PUT')
      }
      return errorJson(
        404,
        `no route ${req.method} ${path.slice(0, 200)}: name the server's base URL; it serves /v1/ (PROTOCOL.md)`,
      )
    } catch (err) {
      if (err instanceof Refusal) {
        // The bucket's or the issuer's fault is the operator's to see too.
        if (err.status >= 500)
          console.error(`vx-cache-server: ${req.method} ${url.pathname}: ${err.message}`)
        return errorJson(err.status, err.message)
      }
      // Never swallowed: the client warns with what the server says.
      console.error(`vx-cache-server: ${req.method} ${url.pathname}: ${String(err)}`)
      return errorJson(500, message(err))
    }
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function readJson(req: Request, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    throw new Refusal(400, 'send the body as Content-Type: application/json')
  }
  if (Number(req.headers.get('content-length') ?? 0) > max) {
    throw new Refusal(413, `the body is at most ${max} bytes`)
  }
  const text = await textUpTo(req, max)
  try {
    return JSON.parse(text)
  } catch {
    throw new Refusal(400, 'the body is not JSON')
  }
}

function contentLength(req: Request): number {
  const length = req.headers.get('content-length')
  if (length === null) throw new Refusal(400, 'an upload names its Content-Length')
  const size = Number(length)
  if (!isCount(size)) throw new Refusal(400, 'Content-Length is not a byte count')
  return size
}

const field = (body: unknown, name: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined

/**
 * The body as text, refused past `max` bytes as they arrive: a chunked body
 * names no length, and was read whole before it was measured.
 */
async function textUpTo(req: Request, max: number): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  // Leaving the loop by a throw cancels the stream.
  for await (const chunk of req.body ?? []) {
    seen += chunk.byteLength
    if (seen > max) throw new Refusal(413, `the body is at most ${max} bytes`)
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}
