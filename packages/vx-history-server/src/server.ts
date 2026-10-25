// The vx-history protocol, v1 (PROTOCOL.md), as one fetch handler over a
// `Store`: Bun and Workers serve the same one.

import { type Authorize, Refusal, TRUSTED } from '@vzn/vx-devtools'
import type { Report, Store } from './store.js'

/** Reports one upload folds in: a run's tasks. */
export const MAX_UPLOAD_TIMINGS = 10_000
/** Hashes one query names. */
export const MAX_QUERY_HASHES = 10_000
const MAX_STRING = 512
const DAY_MS = 86_400_000

export interface ServerOptions {
  readonly store: Store
  readonly authorize: Authorize
  /** Days a task's row outlives its last report (default 30). */
  readonly timingDays?: number
  /** Milliseconds since the epoch; tests move the clock. */
  readonly now?: () => number
}

export function createHistoryServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { store, authorize } = opts
  const now = opts.now ?? Date.now
  let ready: Promise<void> | undefined
  const schema = (): Promise<void> =>
    (ready ??= store.init().catch((err: unknown) => {
      ready = undefined
      throw err
    }))
  const capabilities = { maxUploadTimings: MAX_UPLOAD_TIMINGS, maxQueryHashes: MAX_QUERY_HASHES }

  // The fold is one upsert, a few ms for a thousand tasks: done inline (M, 2026-10-25).
  async function upload(req: Request): Promise<Response> {
    const access = await authorize(req)
    if (access.write === undefined) throw new Refusal(403, 'this token reads only')
    const reports = parseReports(await readJson(req, MAX_UPLOAD_TIMINGS * 200))
    await schema()
    await store.fold(access.repo, access.write, now(), reports)
    return new Response(null, { status: 204 })
  }

  async function query(req: Request): Promise<Response> {
    const access = await authorize(req)
    const body = await readJson(req, MAX_QUERY_HASHES * 600 + 1000)
    const scope = field(body, 'scope')
    const hashes = field(body, 'hashes')
    if (typeof scope !== 'string' || !/^refs\/\S+$/.test(scope) || scope.length > MAX_STRING) {
      throw new Refusal(400, 'scope: a ref, refs/...')
    }
    if (
      !Array.isArray(hashes) ||
      hashes.length > MAX_QUERY_HASHES ||
      !hashes.every((h) => isOpaque(h))
    ) {
      throw new Refusal(400, `hashes: a list of up to ${MAX_QUERY_HASHES} strings`)
    }
    // A branch with no row for a task reads trusted (main's); a trusted ref is trusted.
    const scopes = access.trustedRef(scope) ? [TRUSTED] : [scope, TRUSTED]
    await schema()
    const rows = await store.read(access.repo, scopes, hashes as string[])
    return Response.json({ timings: Object.fromEntries(rows) })
  }

  let swept = 0
  // At most one sweep a day per node, on an upload: no timer, no cron.
  const sweep = async (): Promise<void> => {
    const t = now()
    if (t - swept < DAY_MS) return
    swept = t
    await store.sweep(t - (opts.timingDays ?? 30) * DAY_MS)
  }

  return async (req) => {
    const path = new URL(req.url).pathname
    try {
      if (new URL(req.url).search !== '') throw new Refusal(400, 'no query parameters')
      if (path === '/v1/timings/upload') {
        if (req.method !== 'POST') return notAllowed('POST')
        const res = await upload(req)
        await sweep()
        return res
      }
      if (path === '/v1/timings/query') {
        return req.method === 'POST' ? await query(req) : notAllowed('POST')
      }
      if (path === '/v1/capabilities') {
        if (req.method !== 'GET') return notAllowed('GET')
        await authorize(req)
        return Response.json(capabilities)
      }
      return errorJson(404, 'no such route')
    } catch (err) {
      if (err instanceof Refusal) return errorJson(err.status, err.message)
      console.error(`vx-history-server: ${req.method} ${path}: ${String(err)}`)
      return errorJson(500, 'internal error')
    }
  }
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  500: 'internal_error',
}

/** Every refusal: `{ code, message }`, the message saying what to fix. */
export function errorJson(status: number, message: string): Response {
  return Response.json({ code: CODES[status] ?? 'error', message }, { status })
}

function notAllowed(allow: string): Response {
  const res = errorJson(405, `use ${allow}`)
  res.headers.set('allow', allow)
  return res
}

const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined

const isOpaque = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= MAX_STRING

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

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

/** A run's reports, as the store folds them: unknown fields are dropped. */
function parseReports(body: unknown): Report[] {
  const list = field(body, 'timings')
  if (!Array.isArray(list) || list.length > MAX_UPLOAD_TIMINGS) {
    throw new Refusal(400, `timings: a list of up to ${MAX_UPLOAD_TIMINGS}`)
  }
  const seen = new Set<string>()
  return list.map((x: unknown, i): Report => {
    const bad = (what: string): never => {
      throw new Refusal(400, `timings[${i}].${what}`)
    }
    const hash = field(x, 'hash')
    const durationMs = field(x, 'durationMs')
    const cores = field(x, 'cores')
    const rssBytes = field(x, 'rssBytes')
    if (!isOpaque(hash)) bad(`hash: a string of up to ${MAX_STRING} characters`)
    // One row per task: a second report of it in one upload would fold twice.
    if (seen.has(hash as string)) bad('hash: each task once')
    seen.add(hash as string)
    if (!isCount(durationMs)) bad('durationMs: whole milliseconds')
    if (
      cores !== undefined &&
      !(typeof cores === 'number' && Number.isFinite(cores) && cores >= 0)
    ) {
      bad('cores: a number of cores')
    }
    if (rssBytes !== undefined && !isCount(rssBytes)) bad('rssBytes: a byte count')
    return {
      hash: hash as string,
      durationMs: durationMs as number,
      ...(cores === undefined ? {} : { cores: cores as number }),
      ...(rssBytes === undefined ? {} : { rssBytes: rssBytes as number }),
    }
  })
}
