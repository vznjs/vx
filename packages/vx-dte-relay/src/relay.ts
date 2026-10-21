// The relay of PROTOCOL.md: per-run mailboxes between one orchestrator and
// its agents, held in memory: a relay restart ends the runs it carried.

import { TokenError, type VerifiedToken } from './oidc.js'

export interface RelayOptions {
  /**
   * Checks a request's bearer token; `undefined` admits every request
   * (`--no-auth`, loopback only: tests and the `local()` adapter).
   */
  verify?: ((token: string) => Promise<VerifiedToken>) | undefined
  /** How often a participant must be heard from; lost after three. */
  heartbeatMs?: number
}

export interface Relay {
  fetch(req: Request): Promise<Response>
  /** Answers every held poll and stops the sweep. */
  close(): void
}

interface Message {
  from: string
  body: unknown
}

interface Participant {
  id: string
  role: 'orchestrator' | 'agent'
  info: unknown
  seen: number
  queue: Message[]
  waiter?: (() => void) | undefined
}

interface Run {
  bound?: VerifiedToken
  closed: boolean
  orchestrator?: Participant
  byId: Map<string, Participant>
  closedAt?: number
}

const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/
const MAX_BODY = 1 << 20
const MAX_QUEUE = 10_000
const MAX_WAIT_MS = 25_000
/** A closed run answers `410` this long, then is forgotten. */
const CLOSED_TTL_MS = 10 * 60_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function createRelay(opts: RelayOptions = {}): Relay {
  const heartbeatMs = opts.heartbeatMs ?? 5_000
  const runs = new Map<string, Run>()

  const deliver = (p: Participant, m: Message): void => {
    if (p.queue.length >= MAX_QUEUE) throw new HttpError(429, 'queue full')
    p.queue.push(m)
    p.waiter?.()
  }

  const close = (run: Run): void => {
    run.closed = true
    run.closedAt = Date.now()
    for (const p of run.byId.values()) {
      if (p.role === 'agent') deliver(p, { from: 'relay', body: { type: 'closed' } })
    }
  }

  const drop = (run: Run, p: Participant): void => {
    if (!run.byId.delete(p.id)) return
    if (p.role === 'orchestrator') {
      close(run)
      // A poll it held has no one to answer to.
      p.waiter?.()
      return
    }
    p.waiter?.()
    if (run.orchestrator !== undefined && !run.closed) {
      deliver(run.orchestrator, { from: 'relay', body: { type: 'lost', id: p.id } })
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, run] of runs) {
      if (run.closed) {
        if (now - run.closedAt! > CLOSED_TTL_MS) runs.delete(id)
        continue
      }
      for (const p of [...run.byId.values()]) {
        if (now - p.seen > 3 * heartbeatMs) drop(run, p)
      }
    }
  }, heartbeatMs)
  // Workers have no unref; there a run ends with its Durable Object.
  ;(sweep as { unref?: () => void }).unref?.()

  const participant = (run: Run, id: unknown): Participant => {
    const p = typeof id === 'string' ? run.byId.get(id) : undefined
    if (p === undefined) throw new HttpError(404, 'unknown id')
    p.seen = Date.now()
    return p
  }

  const join = (run: Run, body: { role?: unknown; info?: unknown }): Response => {
    if (body.role !== 'orchestrator' && body.role !== 'agent') {
      throw new HttpError(400, 'role is orchestrator or agent')
    }
    if (body.role === 'orchestrator' && run.orchestrator !== undefined) {
      throw new HttpError(409, 'the run has an orchestrator')
    }
    const p: Participant = {
      id: crypto.randomUUID().replaceAll('-', ''),
      role: body.role,
      info: body.info ?? null,
      seen: Date.now(),
      queue: [],
    }
    run.byId.set(p.id, p)
    if (p.role === 'orchestrator') {
      run.orchestrator = p
      for (const a of run.byId.values()) {
        if (a.role === 'agent') deliver(p, joined(a))
      }
    } else if (run.orchestrator !== undefined) {
      deliver(run.orchestrator, joined(p))
    }
    return Response.json({ id: p.id, heartbeatMs })
  }

  const send = (run: Run, body: { id?: unknown; to?: unknown; body?: unknown }): Response => {
    const from = participant(run, body.id)
    const to =
      from.role === 'agent'
        ? body.to === 'orchestrator'
          ? run.orchestrator
          : undefined
        : typeof body.to === 'string'
          ? run.byId.get(body.to)
          : undefined
    if (to === undefined || to === from) throw new HttpError(404, 'unknown to')
    deliver(to, { from: from.role === 'orchestrator' ? 'orchestrator' : from.id, body: body.body })
    return new Response(null, { status: 204 })
  }

  const poll = async (run: Run, url: URL, signal: AbortSignal): Promise<Response> => {
    const p = participant(run, url.searchParams.get('id'))
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    if (p.queue.length === 0 && wait > 0) {
      // One held poll per participant: a newer one answers the older.
      p.waiter?.()
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          if (p.waiter === done) p.waiter = undefined
          resolve()
        }
        const timer = setTimeout(done, wait)
        signal.addEventListener('abort', done)
        p.waiter = done
      })
      p.seen = Date.now()
    }
    const messages = p.queue
    p.queue = []
    return Response.json({ messages })
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const m = /^\/v1\/runs\/([^/]+)\/(join|send|poll|leave)$/.exec(url.pathname)
    if (m === null) throw new HttpError(404, 'no such route')
    const [, runId, verb] = m as unknown as [string, string, string]
    if (!RUN_ID.test(runId)) throw new HttpError(400, 'bad run id')
    if ((verb === 'poll') !== (req.method === 'GET') || !['GET', 'POST'].includes(req.method)) {
      throw new HttpError(405, 'wrong method')
    }
    const token = await authorize(req, opts.verify)
    let run = runs.get(runId)
    if (token !== undefined && run?.bound !== undefined && !sameRun(run.bound, token)) {
      throw new HttpError(403, 'token of another run')
    }
    if (run?.closed === true) throw new HttpError(410, 'run closed')
    if (verb === 'poll') return poll(run ?? missing(), url, req.signal)
    const body = await readBody(req)
    if (verb === 'join') {
      if (run === undefined) {
        run = { closed: false, byId: new Map(), ...(token !== undefined ? { bound: token } : {}) }
        runs.set(runId, run)
      }
      return join(run, body)
    }
    if (run === undefined) missing()
    if (verb === 'send') return send(run, body)
    drop(run, participant(run, body['id']))
    return new Response(null, { status: 204 })
  }

  return {
    async fetch(req) {
      try {
        return await handle(req)
      } catch (err) {
        if (err instanceof HttpError || err instanceof TokenError) {
          return Response.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
    },
    close() {
      clearInterval(sweep)
      for (const run of runs.values()) for (const p of run.byId.values()) p.waiter?.()
    },
  }
}

const joined = (a: Participant): Message => ({
  from: 'relay',
  body: { type: 'joined', id: a.id, info: a.info },
})

function missing(): never {
  throw new HttpError(404, 'unknown run')
}

function sameRun(a: VerifiedToken, b: VerifiedToken): boolean {
  return a.iss === b.iss && a.run.length === b.run.length && a.run.every((v, i) => v === b.run[i])
}

async function authorize(
  req: Request,
  verify: RelayOptions['verify'],
): Promise<VerifiedToken | undefined> {
  if (verify === undefined) return undefined
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')
  if (m === null) throw new HttpError(401, 'no bearer token')
  return verify(m[1]!)
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  const text = await req.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {}
  throw new HttpError(400, 'body is not a JSON object')
}
