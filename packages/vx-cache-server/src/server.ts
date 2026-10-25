// vx-cache v1 (PROTOCOL.md) over any `Blobs` bucket: one fetch handler
// the Bun server, the Worker and the Docker image all serve. No database:
// an artifact is one object, named by its repository, scope and hash, and
// a read names the exact scope it wants (M, 2026-10-25).

import { type Access, type Authorize, Refusal, TRUSTED } from '@vzn/vx-devtools'
import { BATCH_TYPE, errorJson, isCount, isHash, LIMIT_HEADERS, SCOPE_HEADER } from './protocol.js'
import { blobName, type Blobs } from './store.js'

/** What an operator may set; each defaults, and a backend may cap them. */
export interface Limits {
  /** Exact `{ scope, hash }` pairs one check names. */
  readonly maxCheckKeys: number
  /** Artifacts one upload or batch download carries. */
  readonly maxBatchArtifacts: number
  /** The largest upload, in bytes: its artifacts together, the line aside. */
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

/** Bytes one line of an upload names per artifact, at most. */
const LINE_PER_ARTIFACT = 160
/** The largest first line an upload of `n` artifacts has. */
export const lineBytes = (n: number): number => n * LINE_PER_ARTIFACT + 64

const REF = /^refs\/\S{1,500}$/

/** `x-vx-scope`: the ref percent-encoded, as a header carries bytes and a branch name any UTF-8. */
function decodeScope(header: string | null): string | null {
  if (header === null) return null
  try {
    return decodeURIComponent(header)
  } catch {
    throw new Refusal(400, `${SCOPE_HEADER}: a ref, percent-encoded`)
  }
}

export function createCacheServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { blobs, authorize } = opts
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits }
  const limitHeaders = Object.fromEntries(
    Object.entries(LIMIT_HEADERS).map(([k, h]) => [h, String(limits[k as keyof Limits])]),
  )

  /** A ref the client names, as the scope it reads: a ref a trust rule names is trusted. */
  const scopeOf = (ref: unknown, access: Access): string => {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new Refusal(400, 'scope: a ref, refs/...')
    return access.trustedRef(ref) ? TRUSTED : ref
  }

  const writeScope = (access: Access): string => {
    if (access.write === undefined) throw new Refusal(403, 'this token reads only')
    return access.write
  }

  /** `{ keys: [{ scope, hash }] }`, up to `max`: each as the object it names. */
  async function keysOf(req: Request, access: Access, max: number) {
    const keys = field(await readJson(req, max * 600 + 100), 'keys')
    if (!Array.isArray(keys) || keys.length > max) {
      throw new Refusal(400, `keys: up to ${max} of { scope, hash }`)
    }
    return keys.map((k: unknown) => {
      const hash = field(k, 'hash')
      if (typeof hash !== 'string' || !isHash(hash)) {
        throw new Refusal(400, 'keys[].hash: 1 to 128 hex digits')
      }
      // Answered under the ref asked, though a trusted ref reads trusted.
      const scope = field(k, 'scope') as string
      return { scope, hash, name: blobName(access.repo, scopeOf(scope, access), hash) }
    })
  }

  async function artifact(req: Request, hash: string): Promise<Response> {
    if (!isHash(hash)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    const scope = scopeOf(decodeScope(req.headers.get(SCOPE_HEADER)), access)
    const blob = await blobs.get(blobName(access.repo, scope, hash))
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
   * An upload: a JSON line naming each artifact's hash and size, then their
   * bytes in that order, stored in the token's scope. One the scope or
   * trusted already holds is skipped, and when every one is, the answer
   * comes before the bytes are read.
   */
  async function upload(req: Request): Promise<Response> {
    const access = await authorize(req)
    const scope = writeScope(access)
    if (!(req.headers.get('content-type') ?? '').startsWith(BATCH_TYPE)) {
      throw new Refusal(400, `the body is ${BATCH_TYPE}`)
    }
    const maxLine = lineBytes(limits.maxBatchArtifacts)
    const length = contentLength(req)
    if (length > limits.maxUploadBytes + maxLine) {
      throw new Refusal(413, `an upload is at most ${limits.maxUploadBytes} bytes`)
    }
    const body = parts(req.body ?? new Blob([]).stream())
    const head = await body.line(maxLine)
    let index: unknown
    try {
      index = JSON.parse(head.text)
    } catch {
      throw new Refusal(400, 'the first line is not JSON')
    }
    const list = field(index, 'artifacts')
    const bad = (): never => {
      throw new Refusal(
        400,
        `artifacts: 1 to ${limits.maxBatchArtifacts} of { hash, size }, each hash once`,
      )
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > limits.maxBatchArtifacts) bad()
    const items = (list as unknown[]).map((x) => {
      const hash = field(x, 'hash')
      const size = field(x, 'size')
      if (typeof hash !== 'string' || !isHash(hash) || !isCount(size)) bad()
      return { hash: hash as string, size: size as number }
    })
    if (new Set(items.map((i) => i.hash)).size !== items.length) bad()
    const total = items.reduce((n, i) => n + i.size, 0)
    if (total > limits.maxUploadBytes) {
      throw new Refusal(413, `an upload is at most ${limits.maxUploadBytes} bytes`)
    }
    if (head.bytes + total !== length) {
      throw new Refusal(400, 'Content-Length is not the line and the sizes it names')
    }
    const held = await Promise.all(
      items.map(async (i) => {
        if ((await blobs.size(blobName(access.repo, scope, i.hash))) !== null) return true
        return (
          scope !== TRUSTED && (await blobs.size(blobName(access.repo, TRUSTED, i.hash))) !== null
        )
      }),
    )
    if (held.every(Boolean)) {
      await body.cancel()
      return new Response(null, { status: 204 })
    }
    for (const [n, i] of items.entries()) {
      if (held[n]) {
        await body.skip(i.size)
        continue
      }
      try {
        await blobs.put(blobName(access.repo, scope, i.hash), body.next(i.size), i.size)
      } catch (err) {
        if (err instanceof Refusal) throw err
        throw new Refusal(502, `the bucket refused the artifact: ${message(err)}`)
      }
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
      if (path === '/v1/artifacts/upload') {
        return req.method === 'POST' ? await upload(req) : notAllowed('POST')
      }
      if (path === '/v1/artifacts/check') {
        return req.method === 'POST' ? await check(req) : notAllowed('POST')
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

/** A body read as a first line, then parts of known sizes, in order. */
function parts(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let rest: Uint8Array | undefined
  const chunk = async (): Promise<Uint8Array | undefined> => {
    if (rest !== undefined) {
      const r = rest
      rest = undefined
      return r
    }
    const { done, value } = await reader.read()
    return done ? undefined : value
  }
  const short = () => new Refusal(400, 'the body ended before the sizes its line names')
  const next = (size: number): ReadableStream<Uint8Array> => {
    let left = size
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        if (left === 0) return c.close()
        const got = await chunk()
        if (got === undefined) return c.error(short())
        const take = got.length > left ? got.subarray(0, left) : got
        if (got.length > left) rest = got.subarray(left)
        left -= take.length
        c.enqueue(take)
        if (left === 0) c.close()
      },
    })
  }
  return {
    /** The first line, without its `\n`, and its bytes with it. */
    async line(max: number): Promise<{ text: string; bytes: number }> {
      const seen: Uint8Array[] = []
      let n = 0
      for (;;) {
        const got = await chunk()
        if (got === undefined) throw new Refusal(400, 'the body has no first line')
        const at = got.indexOf(10)
        if (at >= 0) {
          seen.push(got.subarray(0, at))
          if (at + 1 < got.length) rest = got.subarray(at + 1)
          const text = new TextDecoder().decode(Buffer.concat(seen))
          return { text, bytes: n + at + 1 }
        }
        seen.push(got)
        n += got.length
        if (n > max) throw new Refusal(413, `the first line is at most ${max} bytes`)
      }
    },
    next,
    async skip(size: number): Promise<void> {
      for await (const _ of next(size));
    },
    cancel: () => reader.cancel(),
  }
}

const field = (body: unknown, name: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
