// The relay of PROTOCOL.md: per-run mailboxes between one orchestrator and
// its agents, held in memory: a relay restart ends the runs it carried,
// unless a `store` keeps them (a Durable Object's, across hibernation).

import { TokenError, type VerifiedToken } from './oidc.js'

export interface RelayOptions {
  /**
   * Checks a request's bearer token; `undefined` admits every request
   * (`--no-auth`, loopback only: tests and the `local()` adapter). It gets
   * the request too, for a relay whose audience is the URL it is reached at.
   */
  verify?: ((token: string, req: Request) => Promise<VerifiedToken>) | undefined
  /** How often a participant must be heard from; lost after three. */
  heartbeatMs?: number
  /** Keeps runs, participants and queued messages across a restart. */
  store?: RelayStore | undefined
  /**
   * Answers a participant's `socket` request, which `join` then offers; the
   * host accepts the websocket and `attach`es it.
   */
  upgrade?: ((key: string, id: string, req: Request) => Response) | undefined
  /** `false`: the host calls `sweep()` itself (a timer keeps a Durable Object from hibernating). */
  timer?: boolean
}

/** A Durable Object's synchronous `storage.kv`. */
export interface RelayStore {
  put(key: string, value: unknown): void
  delete(key: string): unknown
  list(opts: { prefix: string }): Iterable<[string, unknown]>
}

/** A participant's websocket, as its host holds it. */
export interface RelaySocket {
  send(text: string): void
  close(): void
}

export interface Relay {
  fetch(req: Request): Promise<Response>
  /** Pushes the participant's messages down `socket`; false if it is gone. */
  attach(key: string, id: string, socket: RelaySocket): boolean
  detach(key: string, id: string, socket: RelaySocket): void
  /** One frame a participant sent down its socket; returns the answer frame. */
  frame(key: string, id: string, text: string): string
  /** The participant was heard from at `at` (a websocket ping the host answered). */
  seen(key: string, id: string, at: number): void
  /** Loses the silent and forgets old runs; returns when to sweep next, if any run is left. */
  sweep(): number | undefined
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
  /** The queue's size, in bytes of the bodies that filled it. */
  bytes: number
  /** The store's sequence of the queue's first message. */
  head: number
  waiter?: (() => void) | undefined
  socket?: RelaySocket | undefined
}

interface Run {
  key: string
  closed: boolean
  orchestrator?: Participant
  byId: Map<string, Participant>
  closedAt?: number
  /** The CI job its orchestrator joined from (`VerifiedToken.job`); only that job acts as it. */
  pin?: string
}

/** A random (v4) UUID: no one can guess a run id to open it first or join it. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY = 1 << 20
const MAX_QUEUE = 10_000
/** 10 000 bodies of 1 MiB would be 10 GiB held for one participant that does not poll. */
const MAX_QUEUE_BYTES = 64 << 20
const MAX_WAIT_MS = 25_000
/** A closed run holds its participants this long. */
const CLOSED_TTL_MS = 10 * 60_000
/**
 * A closed run answers `410` this long, so its id never takes another
 * orchestrator while one of its agents could still be about.
 */
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60_000

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
  const store = opts.store
  // A run's key holds `\0`s of its own.
  const runAt = (key: string): string => `r/${encodeURIComponent(key)}`
  const pAt = (run: Run, id: string): string => `p/${encodeURIComponent(run.key)}/${id}`
  const mAt = (run: Run, id: string, seq: number): string =>
    `m/${encodeURIComponent(run.key)}/${id}/${String(seq).padStart(12, '0')}`
  const saveRun = (run: Run): void =>
    store?.put(runAt(run.key), {
      closed: run.closed,
      closedAt: run.closedAt ?? null,
      pin: run.pin ?? null,
    })

  const deliver = (run: Run, p: Participant, m: Message, bytes = 0): void => {
    if (p.socket !== undefined && p.queue.length === 0) {
      try {
        p.socket.send(JSON.stringify({ messages: [m] }))
        return
      } catch {
        p.socket = undefined
      }
    }
    if (p.queue.length >= MAX_QUEUE || p.bytes + bytes > MAX_QUEUE_BYTES) {
      throw new HttpError(429, 'queue full')
    }
    store?.put(mAt(run, p.id, p.head + p.queue.length), m)
    p.queue.push(m)
    p.bytes += bytes
    p.waiter?.()
  }

  const drain = (run: Run, p: Participant): Message[] => {
    const messages = p.queue
    for (let i = 0; i < messages.length; i++) store?.delete(mAt(run, p.id, p.head + i))
    p.head += messages.length
    p.queue = []
    p.bytes = 0
    return messages
  }

  const close = (run: Run): void => {
    run.closed = true
    run.closedAt = Date.now()
    saveRun(run)
    for (const p of run.byId.values()) {
      if (p.role === 'agent') deliver(run, p, { from: 'relay', body: { type: 'closed' } })
    }
  }

  const drop = (run: Run, p: Participant): void => {
    if (!run.byId.delete(p.id)) return
    drain(run, p)
    store?.delete(pAt(run, p.id))
    // Its next request, over HTTP, learns it is gone.
    p.socket?.close()
    if (p.role === 'orchestrator') {
      close(run)
      // A poll it held has no one to answer to.
      p.waiter?.()
      return
    }
    p.waiter?.()
    if (run.orchestrator !== undefined && !run.closed) {
      deliver(run, run.orchestrator, { from: 'relay', body: { type: 'lost', id: p.id } })
    }
  }

  const empty = (run: Run): void => {
    for (const p of run.byId.values()) {
      drain(run, p)
      store?.delete(pAt(run, p.id))
    }
    run.byId.clear()
    delete run.orchestrator
  }

  const forget = (run: Run): void => {
    runs.delete(run.key)
    empty(run)
    store?.delete(runAt(run.key))
  }

  const sweep = (): number | undefined => {
    const now = Date.now()
    let next: number | undefined
    const at = (t: number): void => {
      next = Math.min(next ?? t, t)
    }
    for (const run of [...runs.values()]) {
      if (run.closed) {
        if (now - run.closedAt! > TOMBSTONE_TTL_MS) forget(run)
        else if (now - run.closedAt! > CLOSED_TTL_MS) {
          empty(run)
          at(run.closedAt! + TOMBSTONE_TTL_MS + 1)
        } else at(run.closedAt! + CLOSED_TTL_MS + 1)
        continue
      }
      for (const p of [...run.byId.values()]) {
        if (now - p.seen > 3 * heartbeatMs) drop(run, p)
      }
      // Agents whose orchestrator never joined: nothing would close it.
      if (run.closed) at(run.closedAt! + CLOSED_TTL_MS + 1)
      else if (run.byId.size === 0) forget(run)
      else for (const p of run.byId.values()) at(p.seen + 3 * heartbeatMs + 1)
    }
    return next
  }
  const timer = opts.timer === false ? undefined : setInterval(sweep, heartbeatMs)
  ;(timer as { unref?: () => void } | undefined)?.unref?.()

  if (store !== undefined) restore(store, runs)

  /** `token` 'socket': the frame came down a socket its upgrade already checked. */
  const participant = (
    run: Run,
    id: unknown,
    token: VerifiedToken | undefined | 'socket',
  ): Participant => {
    const p = typeof id === 'string' ? run.byId.get(id) : undefined
    if (p === undefined) throw new HttpError(404, 'unknown id')
    // An id is a bearer secret: one that leaks still acts as the orchestrator only from its job.
    if (
      p.role === 'orchestrator' &&
      run.pin !== undefined &&
      token !== 'socket' &&
      token?.job !== run.pin
    ) {
      throw new HttpError(403, 'not the run’s orchestrator job')
    }
    p.seen = Date.now()
    return p
  }

  const join = (
    run: Run,
    body: { role?: unknown; info?: unknown },
    token: VerifiedToken | undefined,
  ): Response => {
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
      bytes: 0,
      head: 0,
    }
    run.byId.set(p.id, p)
    store?.put(pAt(run, p.id), { role: p.role, info: p.info })
    if (p.role === 'orchestrator') {
      run.orchestrator = p
      if (token?.job !== undefined) {
        run.pin = token.job
        saveRun(run)
      }
      for (const a of run.byId.values()) {
        if (a.role === 'agent') deliver(run, p, joined(a))
      }
    } else if (run.orchestrator !== undefined) {
      deliver(run, run.orchestrator, joined(p))
    }
    return Response.json({
      id: p.id,
      heartbeatMs,
      ...(opts.upgrade === undefined ? {} : { socket: true }),
    })
  }

  const send = (
    run: Run,
    from: Participant,
    body: { to?: unknown; body?: unknown },
    bytes: number,
  ): void => {
    const to =
      from.role === 'agent'
        ? body.to === 'orchestrator'
          ? run.orchestrator
          : undefined
        : typeof body.to === 'string'
          ? run.byId.get(body.to)
          : undefined
    if (to === undefined || to === from) throw new HttpError(404, 'unknown to')
    deliver(
      run,
      to,
      { from: from.role === 'orchestrator' ? 'orchestrator' : from.id, body: body.body },
      bytes,
    )
  }

  const poll = async (
    run: Run,
    url: URL,
    signal: AbortSignal,
    token: VerifiedToken | undefined,
  ): Promise<Response> => {
    const p = participant(run, url.searchParams.get('id'), token)
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
    return Response.json({ messages: drain(run, p) })
  }

  const live = (key: string): Run => {
    const run = runs.get(key)
    if (run === undefined) missing()
    if (run.closed) throw new HttpError(410, 'run closed')
    return run
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const m = /^\/v1\/runs\/([^/]+)\/(join|send|poll|leave|socket)$/.exec(url.pathname)
    if (m === null) throw new HttpError(404, 'no such route')
    const [, runId, verb] = m as unknown as [string, string, string]
    if (!RUN_ID.test(runId)) throw new HttpError(400, 'run id is not a random UUID')
    const get = verb === 'poll' || verb === 'socket'
    if (get !== (req.method === 'GET') || !['GET', 'POST'].includes(req.method)) {
      throw new HttpError(405, 'wrong method')
    }
    const token = await authorize(req, opts.verify)
    // A run is its id within its repository, so another tenant that learns
    // an id cannot open it first.
    const key = runKey(runId, token)
    let run = runs.get(key)
    if (run?.closed === true) throw new HttpError(410, 'run closed')
    if (verb === 'poll') return poll(run ?? missing(), url, req.signal, token)
    if (verb === 'socket') {
      if (opts.upgrade === undefined) throw new HttpError(404, 'no such route')
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        throw new HttpError(426, 'not a websocket')
      }
      return opts.upgrade(
        key,
        participant(run ?? missing(), url.searchParams.get('id'), token).id,
        req,
      )
    }
    const [body, bytes] = await readBody(req)
    if (verb === 'join') {
      if (run === undefined) {
        run = { key, closed: false, byId: new Map() }
        runs.set(key, run)
        saveRun(run)
      }
      return join(run, body, token)
    }
    if (run === undefined) missing()
    if (verb === 'send') {
      send(run, participant(run, body['id'], token), body, bytes)
      return new Response(null, { status: 204 })
    }
    drop(run, participant(run, body['id'], token))
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
    attach(key, id, socket) {
      const run = runs.get(key)
      const p = run?.closed === false ? run.byId.get(id) : undefined
      if (run === undefined || p === undefined) return false
      p.socket = socket
      p.seen = Date.now()
      p.waiter?.()
      if (p.queue.length > 0) {
        const messages = drain(run, p)
        try {
          socket.send(JSON.stringify({ messages }))
        } catch {
          p.socket = undefined
          for (const m of messages) deliver(run, p, m)
        }
      }
      return true
    },
    detach(key, id, socket) {
      const p = runs.get(key)?.byId.get(id)
      if (p?.socket === socket) p.socket = undefined
    },
    frame(key, id, text) {
      let n: unknown = null
      try {
        if (text.length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
        let body: { n?: unknown; to?: unknown; body?: unknown }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          throw new HttpError(400, 'frame is not JSON')
        }
        n = body?.n ?? null
        const run = live(key)
        send(run, participant(run, id, 'socket'), body, text.length)
        return JSON.stringify({ n })
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        return JSON.stringify({ n, status: err.status, error: err.message })
      }
    },
    seen(key, id, at) {
      const p = runs.get(key)?.byId.get(id)
      if (p !== undefined && at > p.seen) p.seen = at
    },
    sweep,
    close() {
      clearInterval(timer)
      for (const run of runs.values()) for (const p of run.byId.values()) p.waiter?.()
    },
  }
}

const joined = (a: Participant): Message => ({
  from: 'relay',
  body: { type: 'joined', id: a.id, info: a.info },
})

/** Runs as `store` kept them; each participant counts as heard from now. */
function restore(store: RelayStore, runs: Map<string, Run>): void {
  const now = Date.now()
  const parts = (k: string): string[] => k.split('/').map(decodeURIComponent)
  for (const [k, v] of store.list({ prefix: 'r/' })) {
    const { closed, closedAt, pin } = v as {
      closed: boolean
      closedAt: number | null
      pin?: string | null
    }
    const [, key] = parts(k) as [string, string]
    runs.set(key, {
      key,
      closed,
      byId: new Map(),
      ...(closedAt === null ? {} : { closedAt }),
      ...(pin == null ? {} : { pin }),
    })
  }
  for (const [k, v] of store.list({ prefix: 'p/' })) {
    const [, key, id] = parts(k) as [string, string, string]
    const run = runs.get(key)
    if (run === undefined) continue
    const { role, info } = v as Pick<Participant, 'role' | 'info'>
    const p: Participant = { id, role, info, seen: now, queue: [], bytes: 0, head: -1 }
    run.byId.set(id, p)
    if (role === 'orchestrator') run.orchestrator = p
  }
  // Listed in key order, so oldest first.
  for (const [k, v] of store.list({ prefix: 'm/' })) {
    const [, key, id, seq] = parts(k) as [string, string, string, string]
    const p = runs.get(key)?.byId.get(id)
    if (p === undefined) continue
    if (p.head < 0) p.head = Number(seq)
    p.queue.push(v as Message)
    p.bytes += JSON.stringify((v as Message).body ?? null).length
  }
  for (const run of runs.values()) for (const p of run.byId.values()) if (p.head < 0) p.head = 0
}

function missing(): never {
  throw new HttpError(404, 'unknown run')
}

/** The run's name: its id, and the issuer and run claims of its tokens. */
export function runKey(runId: string, token: VerifiedToken | undefined): string {
  return token === undefined ? runId : [token.iss, ...token.run, runId].join('\0')
}

async function authorize(
  req: Request,
  verify: RelayOptions['verify'],
): Promise<VerifiedToken | undefined> {
  if (verify === undefined) return undefined
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')
  if (m === null) throw new HttpError(401, 'no bearer token')
  return verify(m[1]!, req)
}

async function readBody(req: Request): Promise<[Record<string, unknown>, number]> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  const text = await req.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return [v as Record<string, unknown>, text.length]
    }
  } catch {}
  throw new HttpError(400, 'body is not a JSON object')
}
