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
    // Each body piped in turn into one stream, never read here: on Workers
    // a copy through this code costs CPU by the byte (851 ms for 43 MB),
    // a pipe 1 ms (Cloudflare's own advice: pipeTo with preventClose).
    const { readable: body, writable } = concat()
    void (async () => {
      const w = writable.getWriter()
      await w.write(line)
      w.releaseLock()
      for (const k of held) {
        const blob = await blobs.get(k.name)
        if (blob === null) throw new Error(`the artifact ${k.hash} is gone`)
        await blob.body.pipeTo(writable, { preventClose: true })
      }
      await writable.close()
    })().catch((err: unknown) => writable.abort(err).catch(() => {}))
    return new Response(body, { headers: { 'content-type': BATCH_TYPE } })
  }

  /**
   * An upload: a JSON line naming each artifact's hash and size, then their
   * bytes in that order, stored in the token's scope. One the scope
   * already holds is skipped, and when every one is, the answer comes
   * before the bytes are read.
   */
  async function upload(req: Request): Promise<Response> {
    const access = await authorize(req)
    const scope = await writeScope(access)
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
      items.map(async (i) => (await blobs.size(await nameOf(access, scope, i.hash))) !== null),
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
        await blobs.put(await nameOf(access, scope, i.hash), body.next(i.size), i.size)
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

declare const IdentityTransformStream:
  | (new () => TransformStream<Uint8Array, Uint8Array>)
  | undefined

/** A pipe of bytes: Workers' native one where it exists, its standard one costs CPU by the chunk (621 ms for 43 MB). */
const concat = (): TransformStream<Uint8Array, Uint8Array> =>
  typeof IdentityTransformStream === 'function'
    ? new IdentityTransformStream()
    : new TransformStream<Uint8Array, Uint8Array>()

/** The largest piece one read takes. */
const PIECE = 1 << 20

interface ByobReader {
  read(view: Uint8Array): Promise<{ done: boolean; value?: Uint8Array }>
  /** Workers' own: fills at least `min` bytes in one call. */
  readAtLeast?(min: number, view: Uint8Array): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
}

/**
 * A body read as a first line, then parts of known sizes, in order. Where
 * the body is a byte stream (Workers) each piece is read whole into a
 * buffer of up to 1 MiB: the runtime's own small chunks cost CPU each
 * (25 ms a MB on Workers), 1 MiB reads 1.6 ms a MB. Elsewhere (Bun) the
 * runtime's chunks pass as they come.
 */
function parts(body: ReadableStream<Uint8Array>) {
  let byob: ByobReader | undefined
  let reader:
    | {
        read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
        cancel(): Promise<void>
      }
    | undefined
  try {
    byob = body.getReader({ mode: 'byob' }) as unknown as ByobReader
  } catch {
    reader = body.getReader() as unknown as typeof reader
  }
  let rest: Uint8Array | undefined
  /** 1 to `max` bytes, or undefined at the body's end. */
  const take = async (max: number): Promise<Uint8Array | undefined> => {
    if (rest !== undefined) {
      const r = rest.length > max ? rest.subarray(0, max) : rest
      rest = rest.length > max ? rest.subarray(max) : undefined
      return r
    }
    if (reader !== undefined) {
      const { done, value } = await reader.read()
      if (done) return undefined
      if (value.length > max) rest = value.subarray(max)
      return value.length > max ? value.subarray(0, max) : value
    }
    const b = byob!
    let view = new Uint8Array(max)
    let have = 0
    while (have < max) {
      const { done, value } = await (b.readAtLeast?.(max - have, view.subarray(have)) ??
        b.read(view.subarray(have)))
      if (value !== undefined) {
        view = new Uint8Array(value.buffer as ArrayBuffer, 0, max)
        have += value.length
      }
      if (done) break
    }
    return have === 0 ? undefined : view.subarray(0, have)
  }
  const short = () => new Refusal(400, 'the body ended before the sizes its line names')
  const next = (size: number): ReadableStream<Uint8Array> => {
    let left = size
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        if (left === 0) return c.close()
        const got = await take(Math.min(left, PIECE))
        if (got === undefined) return c.error(short())
        left -= got.length
        c.enqueue(got)
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
        const got = await take(64 * 1024)
        if (got === undefined) throw new Refusal(400, 'the body has no first line')
        const at = got.indexOf(10)
        if (at >= 0) {
          seen.push(got.subarray(0, at))
          // What `take` held back stays behind what follows the line.
          const after = got.subarray(at + 1)
          if (after.length > 0) rest = rest === undefined ? after : Buffer.concat([after, rest])
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
      for (let left = size; left > 0;) {
        const got = await take(Math.min(left, PIECE))
        if (got === undefined) throw short()
        left -= got.length
      }
    },
    cancel: () => (byob ?? reader)!.cancel(),
  }
}

const field = (body: unknown, name: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
