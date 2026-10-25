// vx-cache v1 (PROTOCOL.md) over any `Blobs` bucket: one fetch handler
// the Bun server, the Worker and the Docker image all serve. No database:
// an artifact is one object, named by its issuer, repository id, scope and
// hash, and a read names the exact scope it wants (M, 2026-10-25).

import { type Access, type Authorize, hashPart, Refusal } from '@vzn/vx-devtools'
import { BATCH_TYPE, errorJson, isCount, isHash, LIMIT_HEADERS, SCOPE_HEADER } from './protocol.js'
import { blobName, type Blobs } from './store.js'

/** What an operator may set; each defaults, and a backend may cap them. */
export interface Limits {
  /** Exact `{ scope, hash }` pairs one check names. */
  readonly maxCheckKeys: number
  /** Artifacts one batch download carries. */
  readonly maxBatchArtifacts: number
  /** The largest upload, in bytes: one artifact. */
  readonly maxUploadBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  maxCheckKeys: 500,
  maxBatchArtifacts: 100,
  maxUploadBytes: 100_000_000,
}

export interface ServerOptions {
  blobs: Blobs
  authorize: Authorize
  limits?: Partial<Limits>
}

const VARS = {
  maxCheckKeys: 'MAX_CHECK_KEYS',
  maxBatchArtifacts: 'MAX_BATCH_ARTIFACTS',
  maxUploadBytes: 'MAX_UPLOAD_BYTES',
} as const

/** `MAX_CHECK_KEYS`, `MAX_BATCH_ARTIFACTS` and `MAX_UPLOAD_BYTES` from the environment, each a whole number above 0. */
export function limitsFrom(env: object): Partial<Limits> {
  const out: Partial<Record<keyof Limits, number>> = {}
  for (const [field, name] of Object.entries(VARS) as [keyof Limits, string][]) {
    const v = (env as Record<string, unknown>)[name]
    if (typeof v !== 'string' || v === '') continue
    const n = Number(v)
    if (!(Number.isSafeInteger(n) && n > 0))
      throw new Error(`${name}: not a whole number above 0: ${v}`)
    out[field] = n
  }
  return out
}

/** A scope on the wire: its ref's `hashPart`, so no ref is ever sent or stored plain (M, 2026-10-25). */
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
    blobName(access.issuer, access.id, scope, hash)

  /** The token's own scope, the one place it writes. */
  const writeScope = (access: Access): Promise<string> => {
    if (access.write === undefined) throw new Refusal(403, 'this token reads only')
    return hashPart(access.write)
  }

  /** `{ keys: [{ scope, hash }] }`, up to `max`: each as the object it names. */
  async function keysOf(req: Request, access: Access, max: number) {
    const keys = field(await readJson(req, max * 600 + 100), 'keys')
    if (!Array.isArray(keys) || keys.length > max) {
      throw new Refusal(400, `keys: up to ${max} of { scope, hash }`)
    }
    return Promise.all(
      keys.map(async (k: unknown) => {
        const hash = field(k, 'hash')
        if (typeof hash !== 'string' || !isHash(hash)) {
          throw new Refusal(400, 'keys[].hash: 1 to 128 hex digits')
        }
        const scope = scopeOf(field(k, 'scope'))
        return { scope, hash, name: await nameOf(access, scope, hash) }
      }),
    )
  }

  async function artifact(req: Request, hash: string): Promise<Response> {
    if (!isHash(hash)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    const scope = scopeOf(req.headers.get(SCOPE_HEADER))
    const blob = await blobs.get(await nameOf(access, scope, hash))
    if (blob === null) return errorJson(404, 'no artifact under this key')
    return new Response(blob.body, {
      headers: { 'content-length': String(blob.size), 'content-type': 'application/octet-stream' },
    })
  }

  // One exact lookup per key, all at once: no fallback chain.
  async function check(req: Request): Promise<Response> {
    const access = await authorize(req)
    const keys = await keysOf(req, access, limits.maxCheckKeys)
    const sizes = await Promise.all(keys.map((k) => blobs.size(k.name)))
    return Response.json({ sizes }, { headers: limitHeaders })
  }

  /**
   * A batch download: a JSON line naming each held artifact's scope, hash
   * and size, in the order asked, then their bytes in that order. One the
   * bucket lost after its line was sent ends the body short.
   */
  async function download(req: Request): Promise<Response> {
    const access = await authorize(req)
    const keys = await keysOf(req, access, limits.maxBatchArtifacts)
    const found = await Promise.all(keys.map((k) => blobs.size(k.name)))
    const held = keys.flatMap((k, i) => {
      const size = found[i]
      return size === null || size === undefined ? [] : [{ ...k, size }]
    })
    const line = new TextEncoder().encode(
      `${JSON.stringify({ artifacts: held.map(({ scope, hash, size }) => ({ scope, hash, size })) })}\n`,
    )
    async function* bytes(): AsyncGenerator<Uint8Array> {
      yield line
      for (const k of held) {
        const blob = await blobs.get(k.name)
        if (blob === null) throw new Error(`the artifact ${k.hash} is gone`)
        yield* blob.body
      }
    }
    const it = bytes()
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await it.next()
        if (done) c.close()
        else c.enqueue(value)
      },
      cancel: async () => void (await it.return(undefined)),
    })
    return new Response(body, { headers: { 'content-type': BATCH_TYPE } })
  }

  /**
   * An upload: one artifact, its bytes the whole body (Turbo's
   * `PUT /v8/artifacts/<hash>`), stored in the token's scope. They reach
   * the bucket without passing through this code, so a large one costs
   * no CPU here (M, 2026-10-25: no batch upload; a batch is split by this
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
    if ((await blobs.size(name)) !== null) {
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
      if (path === '/v1/artifacts/download') {
        return req.method === 'POST' ? await download(req) : notAllowed('POST')
      }
      if (path === '/v1/artifacts/check') {
        return req.method === 'POST' ? await check(req) : notAllowed('POST')
      }
      if (path.startsWith('/v1/artifacts/') && !path.slice('/v1/artifacts/'.length).includes('/')) {
        const hash = path.slice('/v1/artifacts/'.length)
        return req.method === 'PUT' ? await put(req, hash) : notAllowed('PUT')
      }
      if (path.startsWith('/v1/artifacts/download/')) {
        const hash = path.slice('/v1/artifacts/download/'.length)
        return req.method === 'GET' ? await artifact(req, hash) : notAllowed('GET')
      }
      return errorJson(404, 'no such route')
    } catch (err) {
      if (err instanceof Refusal) return errorJson(err.status, err.message)
      // Never swallowed: the client warns with what the server says.
      console.error(err)
      return errorJson(500, message(err))
    }
  }
}

const notAllowed = (allow: string): Response => {
  const res = errorJson(405, `this route takes ${allow}`)
  res.headers.set('allow', allow)
  return res
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function readJson(req: Request, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    throw new Refusal(400, 'the body is application/json')
  }
  if (Number(req.headers.get('content-length') ?? 0) > max) {
    throw new Refusal(413, `the body is at most ${max} bytes`)
  }
  const text = await req.text()
  if (text.length > max) throw new Refusal(413, `the body is at most ${max} bytes`)
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
