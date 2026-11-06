// The vx-history protocol, v1 (PROTOCOL.md), as one fetch handler over a
// `Store`: Bun and Workers serve the same one.

import { type Access, errorJson, notAllowed, Refusal } from '@vzn/vx-devtools'
import type { Outcome, Report, Repo, Store } from './store.js'

/** Reports one upload folds in: a run's tasks. */
export const MAX_UPLOAD_TIMINGS = 10_000
/** Hashes one query names. */
export const MAX_QUERY_HASHES = 10_000
/** Refs one query names, read in order. */
export const MAX_QUERY_REFS = 8
const MAX_STRING = 512
/** A report's bytes at most: its hash at `MAX_STRING`, its numbers at their longest. */
const MAX_REPORT_BYTES = MAX_STRING + 200
/** An outcome's bytes at most: its hash and key at `MAX_STRING`. */
const MAX_OUTCOME_BYTES = 2 * MAX_STRING + 60
const DAY_MS = 86_400_000

export interface ServerOptions {
  readonly store: Store
  /** A request's verified token, checked against the repository it names (`oidcTokenAuth`). */
  readonly authorize: (req: Request, named?: Repo) => Promise<Access | undefined>
  /** Days a task's row outlives its last report (default 30). */
  readonly timingDays?: number
  /** Milliseconds since the epoch; tests move the clock. */
  readonly now?: () => number
}

/** A full ref, as a token names one. */
const REF = /^refs\/\S+$/

export function createHistoryServer(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { store, authorize } = opts
  const now = opts.now ?? Date.now
  let ready: Promise<void> | undefined
  const schema = (): Promise<void> =>
    (ready ??= store.init().catch((err: unknown) => {
      ready = undefined
      throw err
    }))
  const capabilities = {
    maxUploadTimings: MAX_UPLOAD_TIMINGS,
    maxQueryHashes: MAX_QUERY_HASHES,
    maxQueryRefs: MAX_QUERY_REFS,
  }

  // The fold is one upsert, a few ms for a thousand tasks: done inline (2026-10-25).
  async function upload(req: Request): Promise<Response> {
    const access = await authorize(req)
    if (access?.write === undefined) throw new Refusal(403, 'this request reads only')
    const body = await readJson(
      req,
      MAX_UPLOAD_TIMINGS * (MAX_REPORT_BYTES + MAX_OUTCOME_BYTES) + 100,
    )
    const reports = parseReports(body)
    const outcomes = parseOutcomes(body)
    await schema()
    const t = now()
    await store.fold(access, access.write, t, reports)
    if (outcomes.length > 0) await store.record(access, t, outcomes)
    return new Response(null, { status: 204 })
  }

  // One request a run: every hash, each answered from the first ref that holds it.
  async function query(req: Request): Promise<Response> {
    // No token, or a bad one, is refused before the body is read.
    await authorize(req)
    const body = await readJson(req, MAX_QUERY_HASHES * 600 + 10_000)
    const issuer = field(body, 'issuer')
    const repository = field(body, 'repository')
    const refs = field(body, 'refs')
    const hashes = field(body, 'hashes')
    if (
      typeof issuer !== 'string' ||
      !/^https?:\/\/\S+$/.test(issuer) ||
      issuer.length > MAX_STRING
    )
      throw new Refusal(400, "issuer: the CI issuer's URL, as its tokens name it")
    if (
      typeof repository !== 'string' ||
      !/^[^/\s]+(\/[^/\s]+)+$/.test(repository) ||
      repository.length > MAX_STRING
    )
      throw new Refusal(400, 'repository: org/name at the issuer')
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.length > MAX_QUERY_REFS ||
      !refs.every((r) => typeof r === 'string' && REF.test(r) && r.length <= MAX_STRING)
    ) {
      throw new Refusal(
        400,
        `refs: 1 to ${MAX_QUERY_REFS} full refs (refs/heads/main), read in order`,
      )
    }
    if (
      !Array.isArray(hashes) ||
      hashes.length > MAX_QUERY_HASHES ||
      !hashes.every((h) => isOpaque(h))
    ) {
      throw new Refusal(400, `hashes: a list of up to ${MAX_QUERY_HASHES}, each ${OPAQUE_IS}`)
    }
    const repo = (await authorize(req, { issuer, repository }))!
    await schema()
    const [rows, flaky] = await Promise.all([
      store.read(repo, refs as string[], hashes as string[]),
      store.flaky(repo, hashes as string[]),
    ])
    return Response.json({ timings: Object.fromEntries(rows), flaky })
  }

  let swept = 0
  // At most one sweep a day, on an upload: no timer, no cron. Each node
  // asks the database when any node last swept, once a day: a Worker's
  // isolates each swept the whole table on their first upload. A failed
  // sweep fails no upload, which is folded by then; the next tries again.
  const sweep = async (): Promise<void> => {
    const t = now()
    if (t - swept < DAY_MS) return
    swept = t
    try {
      const last = await store.sweptAt()
      if (t - last < DAY_MS) {
        swept = last
        return
      }
      await store.sweep(t - (opts.timingDays ?? 30) * DAY_MS, t)
    } catch (err) {
      swept = 0
      console.error(`vx-history-server: the sweep: ${String(err)}`)
    }
  }

  return async (req) => {
    const res = await answer(req)
    // Every /v1/timings answer, a refusal too: a client learns the limits
    // from its first request, and was asked none apart (2026-11-06).
    if (new URL(req.url).pathname.startsWith('/v1/timings/'))
      for (const [header, value] of limitHeaders) res.headers.set(header, value)
    return res
  }

  async function answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      const search = new URL(req.url).search
      if (search !== '')
        throw new Refusal(
          400,
          `this server takes no query parameters: drop ${search.slice(0, 200)} from the url`,
        )
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
      return errorJson(
        404,
        `no route ${req.method} ${path.slice(0, 200)}: name the server's base URL; it serves /v1/ (PROTOCOL.md)`,
      )
    } catch (err) {
      if (err instanceof Refusal) return errorJson(err.status, err.message)
      // Never swallowed: the client warns with what the server says.
      console.error(`vx-history-server: ${req.method} ${path}: ${String(err)}`)
      return errorJson(500, err instanceof Error ? err.message : String(err))
    }
  }
}

/** The limits as every `/v1/timings` answer names them (PROTOCOL.md § Limits and errors). */
const limitHeaders = [
  ['vx-max-upload-timings', String(MAX_UPLOAD_TIMINGS)],
  ['vx-max-query-hashes', String(MAX_QUERY_HASHES)],
  ['vx-max-query-refs', String(MAX_QUERY_REFS)],
] as const

const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined

/**
 * Each character one byte in JSON, so the body limits hold `MAX_STRING`
 * of them: 10 000 hashes of 512 `é` (two bytes each) were a 413 at the
 * limits the protocol promised, and a control is six (`\u0001`).
 */
const OPAQUE = new RegExp(`^[\\x21\\x23-\\x5b\\x5d-\\x7e]{1,${MAX_STRING}}$`)
const OPAQUE_IS = `1 to ${MAX_STRING} ASCII characters, none a space, control, " or \\`

const isOpaque = (s: unknown): s is string => typeof s === 'string' && OPAQUE.test(s)

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

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
    if (!isOpaque(hash)) bad(`hash: ${OPAQUE_IS}`)
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

/** A run's outcomes of cached tasks (optional), as the flaky record keeps them. */
function parseOutcomes(body: unknown): Outcome[] {
  const list = field(body, 'outcomes')
  if (list === undefined) return []
  if (!Array.isArray(list) || list.length > MAX_UPLOAD_TIMINGS) {
    throw new Refusal(400, `outcomes: a list of up to ${MAX_UPLOAD_TIMINGS}`)
  }
  const seen = new Set<string>()
  return list.map((x: unknown, i): Outcome => {
    const bad = (what: string): never => {
      throw new Refusal(400, `outcomes[${i}].${what}`)
    }
    const hash = field(x, 'hash')
    const key = field(x, 'key')
    const outcome = field(x, 'outcome')
    if (!isOpaque(hash)) bad(`hash: ${OPAQUE_IS}`)
    if (!isOpaque(key)) bad(`key: ${OPAQUE_IS}`)
    const id = `${hash as string}\0${key as string}`
    if (seen.has(id)) bad('key: each task and key once')
    seen.add(id)
    if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'flaky')
      bad("outcome: 'pass', 'fail' or 'flaky'")
    return { hash: hash as string, key: key as string, outcome: outcome as Outcome['outcome'] }
  })
}

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
