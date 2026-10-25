// vx-cache v1 (PROTOCOL.md) over any Blobs and Db: one fetch handler that
// the Bun server and the Worker both serve. Artifacts speak Turbo's remote
// cache API under `/v1`; run history is ours.

import type { Access, Authorize } from './auth.js'
import {
  DIRTY_HASH_HEADER,
  DURATION_HEADER,
  isCount,
  isHash,
  isKey,
  isOpaque,
  parseReadScopes,
  errorJson,
  READ_SCOPES_HEADER,
  Refusal,
  SHA_HEADER,
  TAG_HEADER,
  TAG_MAX,
} from './protocol.js'
import { blobName, type Blobs, firstScopes, type Store, TRUSTED } from './store.js'

export interface ServerOptions {
  blobs: Blobs
  store: Store
  authorize: Authorize
  /** The largest artifact a PUT may store, in bytes. */
  maxArtifactBytes?: number
  /** Milliseconds since the epoch; tests move the clock. */
  now?: () => number
}

/** Workers' free plan takes a request body up to 100 MB. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 100_000_000
/** Hashes one batch query may name (Turbo's spec sets none; Vercel's is 100). */
const MAX_QUERY_KEYS = 1000
/** A run's record, as JSON. */
const MAX_RUN_BYTES = 1 << 20
const MAX_RUN_TASKS = 20_000
/** Tasks one history query may name. */
const MAX_QUERY_TASKS = 1000
/** A history query reads the newest runs up to this many. */
const SCANNED_RUNS = 100
const MAX_SAMPLES = 20
const DEFAULT_SAMPLES = 5
const MAX_LISTED_RUNS = 100
const DEFAULT_LISTED_RUNS = 20

export function createCacheServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { blobs, store, authorize } = opts
  const maxArtifactBytes = opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const now = opts.now ?? Date.now
  let ready: Promise<void> | undefined
  const schema = (): Promise<void> => {
    ready ??= store.init().catch((err: unknown) => {
      ready = undefined
      throw err
    })
    return ready
  }

  /** The scopes a read walks: the header's refs, then the trusted scope. */
  const readScopes = (req: Request): string[] => [
    ...parseReadScopes(req.headers.get(READ_SCOPES_HEADER)),
    TRUSTED,
  ]

  const writeScope = (access: Access): string => {
    if (access.write === undefined) throw new Refusal(403, 'this token reads only')
    return access.write
  }

  async function artifact(req: Request, key: string): Promise<Response> {
    if (!isHash(key)) throw new Refusal(400, 'a hash is 1 to 128 hex digits')
    const access = await authorize(req)
    await schema()
    if (req.method === 'PUT') return put(req, access, key)
    const scopes = readScopes(req)
    const row = firstScopes(await store.artifacts(access.ns, [key], scopes), scopes).get(key)
    const body = row === undefined ? null : await (req.method === 'GET' ? blobs.get(row.blob) : '')
    if (row === undefined || body === null) {
      return req.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : errorJson(404, 'no artifact under this key')
    }
    const headers: Record<string, string> = {
      'content-length': String(row.size),
      'content-type': 'application/octet-stream',
      [DURATION_HEADER]: String(row.duration_ms),
    }
    // The spec's HEAD answers no tag: it is read with the bytes it signs.
    if (row.tag !== null && req.method === 'GET') headers[TAG_HEADER] = row.tag
    if (row.sha !== null) headers[SHA_HEADER] = row.sha
    if (row.dirty_hash !== null) headers[DIRTY_HASH_HEADER] = row.dirty_hash
    return new Response(req.method === 'HEAD' ? null : body, { headers })
  }

  async function put(req: Request, access: Access, key: string): Promise<Response> {
    const scope = writeScope(access)
    const length = req.headers.get('content-length')
    if (length === null) throw new Refusal(400, 'a PUT names its Content-Length')
    const size = Number(length)
    if (!isCount(size)) throw new Refusal(400, 'Content-Length is not a byte count')
    if (size > maxArtifactBytes) {
      throw new Refusal(413, `an artifact is at most ${maxArtifactBytes} bytes`)
    }
    const durationHeader = req.headers.get(DURATION_HEADER)
    const durationMs = durationHeader === null ? 0 : Number(durationHeader)
    if (!isCount(durationMs) || durationHeader === '') {
      throw new Refusal(400, `${DURATION_HEADER} is not whole milliseconds`)
    }
    const text = (header: string, max: number): string | null => {
      const v = req.headers.get(header)
      if (v !== null && v.length > max)
        throw new Refusal(400, `${header} is at most ${max} characters`)
      return v === '' ? null : v
    }
    const tag = text(TAG_HEADER, TAG_MAX)
    const sha = text(SHA_HEADER, 512)
    const dirty = text(DIRTY_HASH_HEADER, 512)
    const stored = Response.json(
      { urls: [new URL(`/v1/artifacts/${key}`, req.url).href] },
      { status: 202 },
    )
    // Immutable: the stored bytes stay, and this upload is not read.
    if (await store.held(access.ns, key, scope)) {
      await req.body?.cancel()
      return stored
    }
    // Its own blob: a racing PUT of the key, on this node or another, never
    // writes over the bytes the row names.
    const name = blobName(access.ns, scope, key, crypto.randomUUID())
    try {
      await blobs.put(name, req.body ?? new Blob([]).stream(), size)
    } catch (err) {
      // quiet: the failure below is what the client hears; a partial blob no row names is unread
      await blobs.delete(name).catch(() => undefined)
      if (err instanceof Refusal) throw err
      throw new Refusal(502, `the bucket refused the artifact: ${message(err)}`)
    }
    // The row is the commit: a blob no row names is never read. A racing
    // PUT's row came first: this blob is the one left over.
    const made = await store.addArtifact({
      ns: access.ns,
      key,
      scope,
      blob: name,
      size,
      duration_ms: durationMs,
      tag,
      sha,
      dirty_hash: dirty,
      created_at: now(),
    })
    if (!made) {
      // The client is answered either way; a blob no row names is never read.
      await blobs.delete(name).catch((err: unknown) => {
        console.error(`left over blob ${name} not deleted: ${message(err)}`)
      })
    }
    return stored
  }

  async function queryArtifacts(req: Request): Promise<Response> {
    const access = await authorize(req)
    const body = await readJson(req, MAX_QUERY_KEYS * 160)
    const hashes = field(body, 'hashes')
    if (
      !Array.isArray(hashes) ||
      hashes.length > MAX_QUERY_KEYS ||
      !hashes.every((k) => typeof k === 'string' && isHash(k))
    ) {
      throw new Refusal(400, `hashes: up to ${MAX_QUERY_KEYS} hex hashes`)
    }
    await schema()
    const scopes = readScopes(req)
    const found = firstScopes(await store.artifacts(access.ns, hashes as string[], scopes), scopes)
    // Turbo's spec: every hash asked, `null` when none is held.
    const out: Record<string, { size: number; taskDurationMs: number; tag?: string } | null> = {}
    for (const h of hashes as string[]) {
      const row = found.get(h)
      out[h] =
        row === undefined
          ? null
          : {
              size: row.size,
              taskDurationMs: row.duration_ms,
              ...(row.tag === null ? {} : { tag: row.tag }),
            }
    }
    return Response.json(out)
  }

  /** Turbo's analytics events: taken and dropped, the run history is what vx keeps. */
  async function events(req: Request): Promise<Response> {
    await authorize(req)
    if (!Array.isArray(await readJson(req, 1 << 20))) {
      throw new Refusal(400, 'the body is a list of events')
    }
    return new Response(null, { status: 200 })
  }

  async function recordRun(req: Request): Promise<Response> {
    const access = await authorize(req)
    const scope = writeScope(access)
    const run = parseRun(await readJson(req, MAX_RUN_BYTES))
    await schema()
    const failed = run.tasks.filter((t) => t.exitCode !== undefined && t.exitCode !== 0).length
    const made = await store.addRun({
      ns: access.ns,
      scope,
      started_at: run.startedAt,
      id: run.id,
      duration_ms: run.durationMs,
      task_count: run.tasks.length,
      failed_count: failed,
      tasks: JSON.stringify(run.tasks),
      created_at: now(),
    })
    return new Response(null, { status: made ? 201 : 200 })
  }

  async function listRuns(req: Request, url: URL): Promise<Response> {
    const access = await authorize(req)
    const limit = numberParam(url, 'limit', DEFAULT_LISTED_RUNS, MAX_LISTED_RUNS)
    await schema()
    const rows = await store.runs(access.ns, readScopes(req), limit)
    return Response.json({
      runs: rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        taskCount: r.task_count,
        failedCount: r.failed_count,
      })),
    })
  }

  async function queryTasks(req: Request): Promise<Response> {
    const access = await authorize(req)
    const body = await readJson(req, MAX_QUERY_TASKS * 600)
    const tasks = field(body, 'tasks')
    if (!Array.isArray(tasks) || tasks.length > MAX_QUERY_TASKS || !tasks.every(isOpaque)) {
      throw new Refusal(400, `tasks: up to ${MAX_QUERY_TASKS} task names`)
    }
    const limit = field(body, 'limit') ?? DEFAULT_SAMPLES
    if (!isCount(limit) || limit < 1 || limit > MAX_SAMPLES) {
      throw new Refusal(400, `limit: 1 to ${MAX_SAMPLES}`)
    }
    await schema()
    const rows = await store.samples(
      access.ns,
      readScopes(req),
      tasks as string[],
      limit,
      SCANNED_RUNS,
    )
    const out: Record<string, unknown[]> = {}
    for (const t of tasks as string[]) out[t] = []
    for (const row of rows) {
      const { task, ...sample } = JSON.parse(row.task) as TaskRecord
      out[task]!.push({ run: row.run, scope: row.scope, ...sample })
    }
    return Response.json({ tasks: out })
  }

  return async (req) => {
    const url = new URL(req.url)
    try {
      const path = url.pathname
      if (path === '/v1/artifacts') {
        return req.method === 'POST' ? await queryArtifacts(req) : notAllowed('POST')
      }
      if (path === '/v1/artifacts/status') {
        if (req.method !== 'GET') return notAllowed('GET')
        await authorize(req)
        return Response.json({ status: 'enabled' })
      }
      if (path === '/v1/artifacts/events') {
        return req.method === 'POST' ? await events(req) : notAllowed('POST')
      }
      if (path.startsWith('/v1/artifacts/')) {
        const key = path.slice('/v1/artifacts/'.length)
        return ['GET', 'HEAD', 'PUT'].includes(req.method)
          ? await artifact(req, key)
          : notAllowed('GET, HEAD, PUT')
      }
      if (path === '/v1/runs') {
        if (req.method === 'POST') return await recordRun(req)
        return req.method === 'GET' ? await listRuns(req, url) : notAllowed('GET, POST')
      }
      if (path === '/v1/tasks/query') {
        return req.method === 'POST' ? await queryTasks(req) : notAllowed('POST')
      }
      return errorJson(404, 'no such route')
    } catch (err) {
      if (err instanceof Refusal) {
        return req.method === 'HEAD'
          ? new Response(null, { status: err.status })
          : errorJson(err.status, err.message)
      }
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

const field = (body: unknown, name: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined

function numberParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name)
  const n = raw === null ? fallback : Number(raw)
  if (!isCount(n) || n < 1 || n > max) throw new Refusal(400, `${name}: 1 to ${max}`)
  return n
}

/** One task of a run, as stored: unknown fields are dropped. */
interface TaskRecord {
  task: string
  key?: string
  durationMs: number
  exitCode?: number
  cached?: boolean
  startedAt?: number
}

interface RunRecord {
  id: string
  startedAt: number
  durationMs: number
  tasks: TaskRecord[]
}

function parseRun(body: unknown): RunRecord {
  const id = field(body, 'id')
  const startedAt = field(body, 'startedAt')
  const durationMs = field(body, 'durationMs')
  const tasks = field(body, 'tasks')
  if (!isOpaque(id)) throw new Refusal(400, 'id: a string of up to 512 characters')
  if (!isCount(startedAt)) throw new Refusal(400, 'startedAt: milliseconds since the epoch')
  if (!isCount(durationMs)) throw new Refusal(400, 'durationMs: whole milliseconds')
  if (!Array.isArray(tasks) || tasks.length > MAX_RUN_TASKS) {
    throw new Refusal(400, `tasks: a list of up to ${MAX_RUN_TASKS}`)
  }
  return {
    id,
    startedAt,
    durationMs,
    tasks: tasks.map((t: unknown, i): TaskRecord => {
      const bad = (what: string): never => {
        throw new Refusal(400, `tasks[${i}].${what}`)
      }
      const task = field(t, 'task')
      const key = field(t, 'key')
      const duration = field(t, 'durationMs')
      const exitCode = field(t, 'exitCode')
      const cached = field(t, 'cached')
      const started = field(t, 'startedAt')
      if (!isOpaque(task)) bad('task: a string of up to 512 characters')
      if (key !== undefined && !(typeof key === 'string' && isKey(key))) bad('key: a key')
      if (!isCount(duration)) bad('durationMs: whole milliseconds')
      if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) bad('exitCode: an integer')
      if (cached !== undefined && typeof cached !== 'boolean') bad('cached: a boolean')
      if (started !== undefined && !isCount(started)) bad('startedAt: milliseconds since the epoch')
      return {
        task: task as string,
        ...(key === undefined ? {} : { key: key as string }),
        durationMs: duration as number,
        ...(exitCode === undefined ? {} : { exitCode: exitCode as number }),
        ...(cached === undefined ? {} : { cached: cached as boolean }),
        ...(started === undefined ? {} : { startedAt: started as number }),
      }
    }),
  }
}
