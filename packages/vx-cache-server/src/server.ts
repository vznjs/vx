// vx-cache v1 (PROTOCOL.md) over any Blobs and Store: one fetch handler
// that the Bun server and the Worker both serve. Artifacts keep Turbo's
// remote cache shapes under `/v1`; timings are what a scheduler learns.

import type { Access, Authorize } from './oidc.js'
import {
  BATCH_TYPE,
  errorJson,
  LIMIT_HEADERS,
  isCount,
  isHash,
  isOpaque,
  parseReadScopes,
  READ_SCOPES_HEADER,
  Refusal,
} from './protocol.js'
import {
  type ArtifactRow,
  blobName,
  type Blobs,
  firstScopes,
  type Timing,
  type Store,
  TRUSTED,
} from './store.js'

export interface ServerOptions {
  blobs: Blobs
  store: Store
  authorize: Authorize
  /** The largest upload, in bytes: its artifacts together, the line aside. */
  maxUploadBytes?: number
  /** Milliseconds since the epoch; tests move the clock. */
  now?: () => number
}

/** Workers' free plan takes a request body up to 100 MB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 100_000_000
/** Hashes one batch query may name (Vercel's is 100). */
const MAX_QUERY_KEYS = 1000
/** Artifacts one batch upload carries. */
const MAX_BATCH_ARTIFACTS = 100
/** Timings an upload's line carries: those of the tasks that made its artifacts, and more. */
const MAX_UPLOAD_TIMINGS = 1000
/** An upload's first line: its artifacts and timings. */
export const MAX_BATCH_LINE = MAX_BATCH_ARTIFACTS * 160 + MAX_UPLOAD_TIMINGS * 600
/** Timings one write carries: a run's tasks. */
const MAX_TIMINGS_WRITTEN = 20_000
/** Task hashes one timing query may name. */
const MAX_QUERY_HASHES = 1000
const MAX_LIMIT = 20
const DEFAULT_LIMIT = 5

export function createCacheServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { blobs, store, authorize } = opts
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  const now = opts.now ?? Date.now
  /** What a client must respect: `/v1/capabilities`, and on each check its batch limits. */
  const capabilities = {
    maxBatchArtifacts: MAX_BATCH_ARTIFACTS,
    maxUploadBytes,
    maxUploadTimings: MAX_UPLOAD_TIMINGS,
    maxCheckHashes: MAX_QUERY_KEYS,
    maxTimingsUploaded: MAX_TIMINGS_WRITTEN,
    maxQueryHashes: MAX_QUERY_HASHES,
    maxQueryLimit: MAX_LIMIT,
  }
  const limitHeaders = Object.fromEntries(
    Object.entries(LIMIT_HEADERS).map(([k, h]) => [
      h,
      String(capabilities[k as keyof typeof LIMIT_HEADERS]),
    ]),
  )
  let ready: Promise<void> | undefined
  const schema = (): Promise<void> => {
    ready ??= store.init().catch((err: unknown) => {
      ready = undefined
      throw err
    })
    return ready
  }

  /**
   * The scopes a read walks: the header's refs in order, a ref a trust
   * rule names read as trusted, then trusted.
   */
  const readScopes = (req: Request, access: Access): string[] => {
    const scopes = parseReadScopes(req.headers.get(READ_SCOPES_HEADER)).map((ref) =>
      access.trustedRef(ref) ? TRUSTED : ref,
    )
    return [...new Set([...scopes, TRUSTED])]
  }

  const writeScope = (access: Access): string => {
    if (access.write === undefined) throw new Refusal(403, 'this token reads only')
    return access.write
  }

  async function artifact(req: Request, key: string): Promise<Response> {
    if (!isHash(key)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    await schema()
    const scopes = readScopes(req, access)
    const row = firstScopes(await store.artifacts(access.repo, [key], scopes), scopes).get(key)
    const body = row === undefined ? null : await blobs.get(blobName(access.repo, row))
    if (row !== undefined && body === null) await lost(access.repo, row)
    if (row === undefined || body === null) return errorJson(404, 'no artifact under this key')
    return new Response(body, {
      headers: { 'content-length': String(row.size), 'content-type': 'application/octet-stream' },
    })
  }

  /**
   * A row whose blob is gone: a sweep deleted the blob of a key written
   * again meanwhile, or a failed upload deleted the name a racing one
   * committed. Held, every check answers it and no job writes it again
   * until it expires, and every batch naming it is cut short.
   */
  const lost = (repo: string, row: ArtifactRow) =>
    store.dropArtifact(repo, row).catch((err: unknown) => {
      console.error(`row of ${row.key} with no blob not dropped: ${message(err)}`)
    })

  /**
   * The keys of `keys` a write to `scope` need not send: held there, or
   * trusted, which every read walks last.
   */
  const heldFor = async (repo: string, keys: readonly string[], scope: string) =>
    new Set((await store.artifacts(repo, keys, [...new Set([scope, TRUSTED])])).map((r) => r.key))

  /** Stores one artifact's bytes, then its row: the row is the commit. */
  async function keep(
    repo: string,
    row: { key: string; scope: string; size: number },
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const name = blobName(repo, row)
    try {
      await blobs.put(name, body, row.size)
    } catch (err) {
      // quiet: the failure below is what the client hears; a blob no row names is unread
      await blobs.delete(name).catch(() => undefined)
      if (err instanceof Refusal) throw err
      throw new Refusal(502, `the bucket refused the artifact: ${message(err)}`)
    }
    if (!(await store.addArtifact({ repo, ...row, created_at: now() }))) {
      // A racing upload's row came first. Of its size, this blob is the one
      // the row names (a whole upload either way); of another, it is left
      // over.
      const held = (await store.artifacts(repo, [row.key], [row.scope]))[0]
      if (held !== undefined && held.size !== row.size) {
        await blobs.delete(name).catch((err: unknown) => {
          console.error(`left over blob ${name} not deleted: ${message(err)}`)
        })
      }
    }
  }

  /**
   * An upload: a JSON line naming each artifact's hash and size, and the
   * timings that ride along, then the artifacts' bytes in that order. The
   * timings are kept first: an upload of held artifacts is answered
   * before its bytes are read.
   */
  async function upload(req: Request): Promise<Response> {
    const access = await authorize(req)
    const scope = writeScope(access)
    if (!(req.headers.get('content-type') ?? '').startsWith(BATCH_TYPE)) {
      throw new Refusal(400, `the body is ${BATCH_TYPE}`)
    }
    const length = contentLength(req)
    if (length > maxUploadBytes + MAX_BATCH_LINE) {
      throw new Refusal(413, `an upload is at most ${maxUploadBytes} bytes`)
    }
    const body = parts(req.body ?? new Blob([]).stream())
    const head = await body.line(MAX_BATCH_LINE)
    let index: unknown
    try {
      index = JSON.parse(head.text)
    } catch {
      throw new Refusal(400, 'the first line is not JSON')
    }
    const list = field(index, 'artifacts')
    const timings =
      field(index, 'timings') === undefined ? [] : parseTimings(index, MAX_UPLOAD_TIMINGS)
    const bad = (): never => {
      throw new Refusal(
        400,
        `artifacts: 1 to ${MAX_BATCH_ARTIFACTS} of { hash, size }, each hash once`,
      )
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH_ARTIFACTS) bad()
    const items = (list as unknown[]).map((x) => {
      const hash = field(x, 'hash')
      const size = field(x, 'size')
      if (typeof hash !== 'string' || !isHash(hash) || !isCount(size)) bad()
      return { key: hash as string, size: size as number }
    })
    if (new Set(items.map((i) => i.key)).size !== items.length) bad()
    const total = items.reduce((n, i) => n + i.size, 0)
    if (total > maxUploadBytes) {
      throw new Refusal(413, `an upload is at most ${maxUploadBytes} bytes`)
    }
    if (head.bytes + total !== length) {
      throw new Refusal(400, 'Content-Length is not the line and the sizes it names')
    }
    await schema()
    if (timings.length > 0) await store.addTimings(access.repo, scope, now(), timings)
    const held = await heldFor(
      access.repo,
      items.map((i) => i.key),
      scope,
    )
    if (items.every((i) => held.has(i.key))) {
      await body.cancel()
      return new Response(null, { status: 204 })
    }
    for (const i of items) {
      if (held.has(i.key)) await body.skip(i.size)
      else await keep(access.repo, { ...i, scope }, body.next(i.size))
    }
    return new Response(null, { status: 204 })
  }

  async function queryArtifacts(req: Request): Promise<Response> {
    const access = await authorize(req)
    const hashes = await hashesOf(req, MAX_QUERY_KEYS)
    await schema()
    const scopes = readScopes(req, access)
    const found = firstScopes(await store.artifacts(access.repo, hashes, scopes), scopes)
    // Every hash asked, `null` when none is held.
    const out: Record<string, { size: number } | null> = {}
    for (const h of hashes) {
      const row = found.get(h)
      out[h] = row === undefined ? null : { size: row.size }
    }
    return Response.json(out, { headers: limitHeaders })
  }

  /**
   * A batch download: a JSON line naming each held artifact's hash and
   * size, in the order asked, then their bytes in that order. A blob the
   * bucket lost after its line was sent ends the body short.
   */
  async function download(req: Request): Promise<Response> {
    const access = await authorize(req)
    const hashes = await hashesOf(req, MAX_BATCH_ARTIFACTS)
    await schema()
    const scopes = readScopes(req, access)
    const found = firstScopes(await store.artifacts(access.repo, hashes, scopes), scopes)
    const rows = [...new Set(hashes)].flatMap((h) => found.get(h) ?? [])
    const line = new TextEncoder().encode(
      `${JSON.stringify({ artifacts: rows.map((r) => ({ hash: r.key, size: r.size })) })}\n`,
    )
    const repo = access.repo
    async function* bytes(): AsyncGenerator<Uint8Array> {
      yield line
      for (const row of rows) {
        const blob = await blobs.get(blobName(repo, row))
        if (blob === null) {
          await lost(repo, row)
          throw new Error(`blob of ${row.key} is gone`)
        }
        yield* blob instanceof Blob ? blob.stream() : blob
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

  async function writeTimings(req: Request): Promise<Response> {
    const access = await authorize(req)
    const scope = writeScope(access)
    const timings = parseTimings(
      await readJson(req, MAX_TIMINGS_WRITTEN * 200),
      MAX_TIMINGS_WRITTEN,
    )
    await schema()
    await store.addTimings(access.repo, scope, now(), timings)
    return new Response(null, { status: 204 })
  }

  async function queryTimings(req: Request): Promise<Response> {
    const access = await authorize(req)
    const body = await readJson(req, MAX_QUERY_HASHES * 600)
    const hashes = field(body, 'hashes')
    if (!Array.isArray(hashes) || hashes.length > MAX_QUERY_HASHES || !hashes.every(isOpaque)) {
      throw new Refusal(400, `hashes: up to ${MAX_QUERY_HASHES} task hashes`)
    }
    const limit = field(body, 'limit') ?? DEFAULT_LIMIT
    if (!isCount(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Refusal(400, `limit: 1 to ${MAX_LIMIT}`)
    }
    await schema()
    // Trusted first, then the header's refs in order.
    const scopes = readScopes(req, access)
    const order = [TRUSTED, ...scopes.filter((s) => s !== TRUSTED)]
    const rows = await store.timings(access.repo, hashes as string[], order, limit)
    const rank = (scope: string): number => order.indexOf(scope)
    // Stable: within a scope the store's newest-first order stays.
    rows.sort((a, b) => rank(a.scope) - rank(b.scope))
    const out: Record<string, Omit<Timing, 'hash'>[]> = {}
    for (const h of hashes as string[]) out[h] = []
    for (const { hash, scope: _, ...timing } of rows) {
      const list = out[hash]!
      if (list.length < limit) list.push(timing)
    }
    return Response.json({ timings: out })
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
        return Response.json(capabilities)
      }
      if (path === '/v1/artifacts/download') {
        return req.method === 'POST' ? await download(req) : notAllowed('POST')
      }
      if (path === '/v1/artifacts/upload') {
        return req.method === 'POST' ? await upload(req) : notAllowed('POST')
      }
      if (path === '/v1/artifacts/check') {
        return req.method === 'POST' ? await queryArtifacts(req) : notAllowed('POST')
      }
      if (path.startsWith('/v1/artifacts/download/')) {
        const key = path.slice('/v1/artifacts/download/'.length)
        return req.method === 'GET' ? await artifact(req, key) : notAllowed('GET')
      }
      if (path === '/v1/timings/upload') {
        return req.method === 'POST' ? await writeTimings(req) : notAllowed('POST')
      }
      if (path === '/v1/timings/query') {
        return req.method === 'POST' ? await queryTimings(req) : notAllowed('POST')
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

async function hashesOf(req: Request, max: number): Promise<string[]> {
  const hashes = field(await readJson(req, max * 160), 'hashes')
  if (
    !Array.isArray(hashes) ||
    hashes.length > max ||
    !hashes.every((k) => typeof k === 'string' && isHash(k))
  ) {
    throw new Refusal(400, `hashes: up to ${max} hex hashes`)
  }
  return hashes as string[]
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

/** A run's timings, as stored: unknown fields are dropped. */
function parseTimings(body: unknown, max: number): Timing[] {
  const timings = field(body, 'timings')
  if (!Array.isArray(timings) || timings.length > max) {
    throw new Refusal(400, `timings: a list of up to ${max}`)
  }
  return timings.map((x: unknown, i): Timing => {
    const bad = (what: string): never => {
      throw new Refusal(400, `timings[${i}].${what}`)
    }
    const hash = field(x, 'hash')
    const durationMs = field(x, 'durationMs')
    const cores = field(x, 'cores') ?? null
    const rssBytes = field(x, 'rssBytes') ?? null
    if (!isOpaque(hash)) bad('hash: a string of up to 512 characters')
    if (!isCount(durationMs)) bad('durationMs: whole milliseconds')
    if (cores !== null && !(typeof cores === 'number' && Number.isFinite(cores) && cores >= 0)) {
      bad('cores: a number of cores')
    }
    if (rssBytes !== null && !isCount(rssBytes)) bad('rssBytes: a byte count')
    return {
      hash: hash as string,
      durationMs: durationMs as number,
      cores: cores as number | null,
      rssBytes: rssBytes as number | null,
    }
  })
}
