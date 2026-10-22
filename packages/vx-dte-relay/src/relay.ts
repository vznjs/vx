// The relay of PROTOCOL.md: per-run mailboxes between one orchestrator and
// its agents, held in memory: a relay restart ends the runs it carried,
// unless a `store` keeps them (a Durable Object's, across hibernation).
// It knows as little as routing needs: a run is a hash, bodies and an
// agent's info are its peers' ciphertext, and no body is ever stored.

import { TokenError, type VerifiedToken } from './oidc.js'
import { importKey, PROOF_HEADER, proofText, verifyProof } from './proof.js'

export interface RelayOptions {
  /**
   * Checks a request's bearer token; `undefined` admits every request
   * (`--no-auth`, loopback only: tests and the `local()` adapter). It gets
   * the request too, for a relay whose audience is the URL it is reached at.
   */
  verify?: ((token: string, req: Request) => Promise<VerifiedToken>) | undefined
  /** How often a participant must be heard from; lost after three. */
  heartbeatMs?: number
  /**
   * Keeps runs and participants across a restart, never a message: a
   * participant whose queue was not empty is lost on restore.
   */
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
  /** An agent's, until the orchestrator is told it joined. */
  info: unknown
  seen: number
  /** Requests it may still make now, and when that was counted (a token bucket). */
  tokens: number
  filled: number
  queue: Message[]
  /** The queue's size, in bytes of the bodies that filled it. */
  bytes: number
  waiter?: (() => void) | undefined
  socket?: RelaySocket | undefined
}

interface Run {
  key: string
  closed: boolean
  orchestrator?: Participant
  byId: Map<string, Participant>
  /** When its first participant joined: a run no orchestrator joins soon is over. */
  openedAt: number
  closedAt?: number
  /** The CI job its orchestrator joined from (`VerifiedToken.job`); only that job acts as it. */
  pin?: string
  /** The public key its orchestrator joined with; only its holder acts as it. */
  cert?: string
  certKey?: Promise<CryptoKey>
  /** Proof nonces seen, and when: each is taken once. */
  nonces?: Map<string, number>
  /** Agents the orchestrator removed, and what it last told each: its next poll reads why. */
  removed?: Map<string, Message[]>
}

/** A random (v4) UUID: no one can guess a run id to open it first or join it. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY = 1 << 20
const MAX_QUEUE = 10_000
/** 10 000 bodies of 1 MiB would be 10 GiB held for one participant that does not poll. */
const MAX_QUEUE_BYTES = 64 << 20
const MAX_WAIT_MS = 25_000
/**
 * A closed run answers `410` this many heartbeats (a minute) to an agent
 * polling over HTTP; one on a socket is told at once, and the run goes
 * when none is left. Its storage goes with it: an object kept a day per
 * run held 100+ on one host (owner, 2026-10-22).
 */
const CLOSED_BEATS = 12
/**
 * A run no orchestrator joined closes after this many heartbeats (ten
 * minutes). Agents start after their orchestrator joins, so one alone is
 * late for a run that ended, which nothing remembers; a CI that starts
 * agents beside it has this long to join.
 */
const ORPHAN_BEATS = 120
/**
 * A participant on a socket is lost after this many heartbeats of silence,
 * not three: its pings cost a host nothing, but each sweep wakes it, and a
 * Durable Object woken every 12 s stayed awake, billed, the whole run
 * (2026-10-22). A socket that closes is still noticed at once; this bounds
 * only one a network stopped carrying, which the orchestrator's lease
 * catches first anyway.
 */
const SOCKET_LOST_BEATS = 12
/** How far a proof's time may be from the relay's: a CI runner's clock drifts. */
const PROOF_SKEW_MS = 2 * 60_000

/**
 * Each participant's requests and frames, as a token bucket: a burst, then
 * a steady rate, so one that loops cannot spend its host's request quota.
 */
const RATE_BURST = 1000
const RATE_PER_SECOND = 100

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** For a `429` of the rate: when the next request is taken. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

const errorBody = (err: HttpError | TokenError): object =>
  err instanceof HttpError && err.retryAfterMs !== undefined
    ? { error: err.message, retryAfterMs: err.retryAfterMs }
    : { error: err.message }

export function createRelay(opts: RelayOptions = {}): Relay {
  const heartbeatMs = opts.heartbeatMs ?? 5_000
  const closedTtl = CLOSED_BEATS * heartbeatMs
  const orphanTtl = ORPHAN_BEATS * heartbeatMs
  const runs = new Map<string, Run>()
  const store = opts.store
  const runAt = (key: string): string => `r/${key}`
  const pAt = (run: Run, id: string): string => `p/${run.key}/${id}`
  /** Marks a participant whose queue holds a message: one a restart would lose. */
  const qAt = (run: Run, id: string): string => `q/${run.key}/${id}`
  const saveRun = (run: Run): void =>
    store?.put(runAt(run.key), {
      closed: run.closed,
      openedAt: run.openedAt,
      closedAt: run.closedAt ?? null,
      pin: run.pin ?? null,
      cert: run.cert ?? null,
    })
  // `seen` too: restored as heard just now, a gone participant kept its
  // object waking every sweep, forever (2026-10-22).
  const saveParticipant = (run: Run, p: Participant): void =>
    store?.put(pAt(run, p.id), { role: p.role, info: p.info, seen: p.seen })

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
    if (p.queue.length === 0) store?.put(qAt(run, p.id), true)
    p.queue.push(m)
    p.bytes += bytes
    p.waiter?.()
  }

  const drain = (run: Run, p: Participant): Message[] => {
    const messages = p.queue
    if (messages.length > 0) store?.delete(qAt(run, p.id))
    p.queue = []
    p.bytes = 0
    return messages
  }

  const close = (run: Run): void => {
    run.closed = true
    run.closedAt = Date.now()
    saveRun(run)
    for (const p of [...run.byId.values()]) {
      if (p.role !== 'agent') continue
      deliver(run, p, { from: 'relay', body: { type: 'closed' } })
      // Down its socket: it has heard, and needs the run no more.
      if (p.queue.length === 0) drop(run, p, false)
    }
    if (run.byId.size === 0) forget(run)
  }

  /** `tell`: the orchestrator hears its agent was lost (not when it removed it). */
  const drop = (run: Run, p: Participant, tell = true): void => {
    if (!run.byId.delete(p.id)) return
    const left = drain(run, p)
    if (!tell) (run.removed ??= new Map()).set(p.id, left)
    store?.delete(pAt(run, p.id))
    store?.delete(qAt(run, p.id))
    // Its next request, over HTTP, learns it is gone.
    p.socket?.close()
    if (p.role === 'orchestrator') {
      close(run)
      // A poll it held has no one to answer to.
      p.waiter?.()
      return
    }
    p.waiter?.()
    if (tell && run.orchestrator !== undefined && !run.closed) {
      deliver(run, run.orchestrator, { from: 'relay', body: { type: 'lost', id: p.id } })
    }
  }

  /** The orchestrator takes an agent it did not admit off the run. */
  const removeAgent = (run: Run, p: Participant, agent: unknown): void => {
    const a = typeof agent === 'string' ? run.byId.get(agent) : undefined
    if (p.role !== 'orchestrator') throw new HttpError(403, 'only the orchestrator removes')
    if (a === undefined || a.role !== 'agent') throw new HttpError(404, 'unknown agent')
    drop(run, a, false)
  }

  /** A closed run's participants, and what it knew of its orchestrator. */
  const empty = (run: Run): void => {
    for (const p of run.byId.values()) {
      drain(run, p)
      store?.delete(pAt(run, p.id))
      store?.delete(qAt(run, p.id))
    }
    run.byId.clear()
    delete run.orchestrator
    delete run.pin
    delete run.cert
    delete run.certKey
    delete run.nonces
    delete run.removed
    if (run.closed) saveRun(run)
  }

  const forget = (run: Run): void => {
    runs.delete(run.key)
    empty(run)
    store?.delete(runAt(run.key))
  }

  const lostAfter = (p: Participant): number =>
    (p.socket === undefined ? 3 : SOCKET_LOST_BEATS) * heartbeatMs
  const sweep = (): number | undefined => {
    const now = Date.now()
    let next: number | undefined
    const at = (t: number): void => {
      next = Math.min(next ?? t, t)
    }
    for (const run of [...runs.values()]) {
      if (!run.closed && run.orchestrator === undefined && now - run.openedAt > orphanTtl) {
        close(run)
      }
      if (run.closed) {
        if (run.byId.size === 0 || now - run.closedAt! > closedTtl) forget(run)
        else at(run.closedAt! + closedTtl + 1)
        continue
      }
      for (const p of [...run.byId.values()]) {
        if (now - p.seen > lostAfter(p)) drop(run, p)
      }
      if (run.closed) {
        if (run.byId.size === 0) forget(run)
        else if (runs.has(run.key)) at(run.closedAt! + closedTtl + 1)
      } else if (run.byId.size === 0) forget(run)
      else {
        for (const p of run.byId.values()) {
          saveParticipant(run, p)
          at(p.seen + lostAfter(p) + 1)
        }
        if (run.orchestrator === undefined) at(run.openedAt + orphanTtl + 1)
      }
    }
    return next
  }
  const timer = opts.timer === false ? undefined : setInterval(sweep, heartbeatMs)
  ;(timer as { unref?: () => void } | undefined)?.unref?.()

  // A participant whose queued messages the restart lost: as if it went silent.
  if (store !== undefined) for (const [run, p] of restore(store, runs)) drop(run, p)

  /** The orchestrator's request is signed by the key it joined with, at most once. */
  const prove = async (run: Run, req: Request, url: URL, body: string, cert = run.cert) => {
    const m = /^(\d+)\.([\w-]{16,64})\.([\w-]+)$/.exec(req.headers.get(PROOF_HEADER) ?? '')
    if (m === null || cert === undefined) {
      throw new HttpError(403, 'not signed by the run’s orchestrator key')
    }
    const [, ts, nonce, sig] = m as unknown as [string, string, string, string]
    const now = Date.now()
    run.nonces ??= new Map()
    for (const [n, at] of run.nonces) if (now - at > 2 * PROOF_SKEW_MS) run.nonces.delete(n)
    if (Math.abs(now - Number(ts)) > PROOF_SKEW_MS || run.nonces.has(nonce)) {
      throw new HttpError(403, 'not signed by the run’s orchestrator key')
    }
    const key = cert === run.cert ? (run.certKey ??= importKey(cert)) : importKey(cert)
    const signed = proofText(req.method, url.pathname + url.search, Number(ts), nonce, body)
    if (!(await verifyProof(await key, sig, signed))) {
      throw new HttpError(403, 'not signed by the run’s orchestrator key')
    }
    run.nonces.set(nonce, now)
  }

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
    const now = Date.now()
    p.tokens = Math.min(RATE_BURST, p.tokens + ((now - p.filled) * RATE_PER_SECOND) / 1000)
    p.filled = now
    if (p.tokens < 1) {
      const wait = Math.ceil(((1 - p.tokens) * 1000) / RATE_PER_SECOND)
      throw new HttpError(429, 'rate limited', wait)
    }
    p.tokens -= 1
    p.seen = Date.now()
    return p
  }

  const join = (
    run: Run,
    body: { role?: unknown; info?: unknown; key?: unknown },
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
      // No one reads the orchestrator's.
      info: body.role === 'agent' ? (body.info ?? null) : null,
      seen: Date.now(),
      tokens: RATE_BURST,
      filled: Date.now(),
      queue: [],
      bytes: 0,
    }
    run.byId.set(p.id, p)
    if (p.role === 'orchestrator') {
      run.orchestrator = p
      run.cert = body.key as string
      if (token?.job !== undefined) run.pin = token.job
      saveRun(run)
      saveParticipant(run, p)
      for (const a of run.byId.values()) {
        if (a.role === 'agent') {
          deliver(run, p, joined(a))
          saveParticipant(run, a)
        }
      }
    } else if (run.orchestrator !== undefined) {
      deliver(run, run.orchestrator, joined(p))
      saveParticipant(run, p)
    } else {
      // Held until an orchestrator joins to read it.
      saveParticipant(run, p)
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
    p: Participant,
    url: URL,
    signal: AbortSignal,
  ): Promise<Response> => {
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
    const m = /^\/v1\/runs\/([^/]+)\/(join|send|poll|leave|remove|socket)$/.exec(url.pathname)
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
    const key = await runKey(runId, token)
    let run = runs.get(key)
    if (run?.closed === true) throw new HttpError(410, 'run closed')
    // As the orchestrator: in its CI job, and signed by the key it joined with.
    const as = async (run: Run, id: unknown, body: string): Promise<Participant> => {
      const p = participant(run, id, token)
      if (p.role === 'orchestrator') await prove(run, req, url, body)
      return p
    }
    if (get) {
      if (run === undefined) missing()
      const id = url.searchParams.get('id') ?? ''
      const told = run.removed?.get(id)
      if (verb === 'poll' && told !== undefined) {
        run.removed!.delete(id)
        return Response.json({ messages: told })
      }
      if (verb === 'poll') return poll(run, await as(run, id, ''), url, req.signal)
      if (opts.upgrade === undefined) throw new HttpError(404, 'no such route')
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        throw new HttpError(426, 'not a websocket')
      }
      return opts.upgrade(key, (await as(run, url.searchParams.get('id'), '')).id, req)
    }
    const [body, text] = await readBody(req)
    if (verb === 'join') {
      if (body['role'] === 'orchestrator') {
        if (
          typeof body['key'] !== 'string' ||
          !(await importKey(body['key']).then(
            () => true,
            () => false,
          ))
        ) {
          throw new HttpError(400, 'an orchestrator joins with key: its P-256 public key')
        }
      }
      if (run === undefined) {
        run = { key, closed: false, byId: new Map(), openedAt: Date.now() }
        runs.set(key, run)
        saveRun(run)
      }
      if (body['role'] === 'orchestrator') {
        if (run.orchestrator !== undefined) throw new HttpError(409, 'the run has an orchestrator')
        await prove(run, req, url, text, body['key'] as string)
      }
      return join(run, body, token)
    }
    if (run === undefined) missing()
    const p = await as(run, body['id'], text)
    if (verb === 'send') {
      send(run, p, body, text.length)
      return new Response(null, { status: 204 })
    }
    if (verb === 'remove') {
      removeAgent(run, p, body['agent'])
      return new Response(null, { status: 204 })
    }
    drop(run, p)
    return new Response(null, { status: 204 })
  }

  return {
    async fetch(req) {
      try {
        return await handle(req)
      } catch (err) {
        if (err instanceof HttpError || err instanceof TokenError) {
          return Response.json(errorBody(err), { status: err.status })
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
        if (text.length > MAX_BODY) {
          // Answered by its number, read without parsing the rest.
          const k = /^\{"n":(\d+)[,}]/.exec(text)?.[1]
          if (k !== undefined) n = Number(k)
          throw new HttpError(413, 'body over 1 MiB')
        }
        let body: {
          n?: unknown
          to?: unknown
          body?: unknown
          leave?: unknown
          remove?: unknown
          sends?: unknown
        }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          throw new HttpError(400, 'frame is not JSON')
        }
        n = body?.n ?? null
        const run = live(key)
        const p = participant(run, id, 'socket')
        // `leave` and `remove` too, so a participant with a socket makes no request after it.
        if (body.leave === true) drop(run, p)
        else if (body.remove !== undefined) removeAgent(run, p, body.remove)
        else if (Array.isArray(body.sends)) {
          // Several sends in one frame: one message the host bills, each answered.
          const results = body.sends.map((one: { to?: unknown; body?: unknown }) => {
            try {
              send(run, p, one, JSON.stringify(one).length)
              return null
            } catch (err) {
              if (!(err instanceof HttpError)) throw err
              return { status: err.status, ...errorBody(err) }
            }
          })
          if (results.some((r) => r !== null)) return JSON.stringify({ n, results })
        } else send(run, p, body, text.length)
        return JSON.stringify({ n })
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        return JSON.stringify({ n, status: err.status, ...errorBody(err) })
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

/** Tells the orchestrator `a` joined, and forgets what it said. */
const joined = (a: Participant): Message => {
  const info = a.info
  a.info = null
  return { from: 'relay', body: { type: 'joined', id: a.id, info } }
}

/**
 * Runs as `store` kept them; each participant counts as heard from now.
 * Returns the participants whose queued messages are gone.
 */
function restore(store: RelayStore, runs: Map<string, Run>): [Run, Participant][] {
  const now = Date.now()
  const parts = (k: string): string[] => k.split('/')
  for (const [k, v] of store.list({ prefix: 'r/' })) {
    const { closed, openedAt, closedAt, pin, cert } = v as {
      closed: boolean
      openedAt?: number
      closedAt: number | null
      pin?: string | null
      cert?: string | null
    }
    const [, key] = parts(k) as [string, string]
    runs.set(key, {
      key,
      closed,
      byId: new Map(),
      openedAt: openedAt ?? now,
      ...(closedAt === null ? {} : { closedAt }),
      ...(pin == null ? {} : { pin }),
      ...(cert == null ? {} : { cert }),
    })
  }
  for (const [k, v] of store.list({ prefix: 'p/' })) {
    const [, key, id] = parts(k) as [string, string, string]
    const run = runs.get(key)
    if (run === undefined) continue
    const { role, info, seen } = v as Pick<Participant, 'role' | 'info'> & { seen?: number }
    const p: Participant = {
      id,
      role,
      info,
      seen: seen ?? now,
      tokens: RATE_BURST,
      filled: now,
      queue: [],
      bytes: 0,
    }
    run.byId.set(id, p)
    if (role === 'orchestrator') run.orchestrator = p
  }
  const lost: [Run, Participant][] = []
  for (const [k] of store.list({ prefix: 'q/' })) {
    const [, key, id] = parts(k) as [string, string, string]
    const run = runs.get(key)
    const p = run?.byId.get(id)
    if (p === undefined) store.delete(k)
    else lost.push([run!, p])
  }
  return lost
}

function missing(): never {
  throw new HttpError(404, 'unknown run')
}

/**
 * The run's name: a SHA-256 of its id and the issuer and run claims of its
 * tokens, so neither storage nor a Durable Object's name says whose it is.
 */
export async function runKey(runId: string, token: VerifiedToken | undefined): Promise<string> {
  const name = token === undefined ? runId : [token.iss, ...token.run, runId].join('\0')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
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

async function readBody(req: Request): Promise<[Record<string, unknown>, string]> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  const text = await req.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'body over 1 MiB')
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return [v as Record<string, unknown>, text]
    }
  } catch {}
  throw new HttpError(400, 'body is not a JSON object')
}
