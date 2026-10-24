// The relay of PROTOCOL.md: per-run mailboxes between one orchestrator and
// its workers, held in memory: a relay restart ends the runs it carried,
// unless a `store` keeps them (a Durable Object's, across hibernation).
// It knows as little as routing needs: a run is a hash, bodies and an
// worker's info are its peers' ciphertext, and no body is ever stored.

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
   * Answers a participant's `socket` request: the host accepts the
   * websocket and `attach`es it. A participant speaks only over it.
   */
  upgrade: (key: string, id: string, req: Request) => Response
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
  close(code?: number, reason?: string): void
}

/** The close code of a socket whose participant the relay lost, let go, or never knew. */
export const GONE = 4404

/**
 * Close `socket` with `code`, said first in a frame (`{ "close": code }`,
 * 0 for none): Bun 1.4.4's client fires its close only once the host ends
 * TCP too, and workerd never did, so a lost worker heard 4404 10 s late,
 * at its own redial limit (PR #4171, 2026-10-23).
 */
export function closeSocket(socket: RelaySocket, code?: number, reason?: string): void {
  try {
    socket.send(JSON.stringify({ close: code ?? 0 }))
    // quiet: a socket that can carry nothing is closed all the same
  } catch {}
  socket.close(code, reason)
}

export interface Relay {
  fetch(req: Request): Promise<Response>
  /**
   * Pushes the participant's messages down `socket`; false if it is gone.
   * A socket its host restored passes when it was last heard (`heardAt`,
   * its last ping, 0 for none): restoring it is no sign of life.
   */
  attach(key: string, id: string, socket: RelaySocket, heardAt?: number): boolean
  detach(key: string, id: string, socket: RelaySocket): void
  /**
   * One frame a participant sent down `socket`, which becomes its socket;
   * returns the answer frame.
   */
  frame(key: string, id: string, text: string, socket?: RelaySocket): string
  /** The participant was heard from at `at` (a websocket ping the host answered). */
  seen(key: string, id: string, at: number): void
  /** Loses the silent and forgets old runs; returns when to sweep next, if any run is left. */
  sweep(): number | undefined
  /** Stops the sweep. */
  close(): void
}

interface Message {
  from: string
  body: unknown
}

interface Participant {
  id: string
  role: 'orchestrator' | 'worker'
  /** A worker's, until the orchestrator is told it joined. */
  info: unknown
  seen: number
  /** The `seen` its host's storage holds. */
  saved?: number
  /** Requests it may still make now, and when that was counted (a token bucket). */
  tokens: number
  filled: number
  queue: Message[]
  /** The queue's size, in bytes of the bodies that filled it. */
  bytes: number
  socket?: RelaySocket | undefined
  /** A participant that joined on its socket: what that socket says first. */
  hello?: string
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
}

/** A random (v4) UUID: no one can guess a run id to open it first or join it. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY = 1 << 20
const MAX_QUEUE = 10_000
/** 10 000 bodies of 1 MiB would be 10 GiB held for one participant with no socket. */
const MAX_QUEUE_BYTES = 64 << 20
/**
 * A participant silent this many heartbeats is lost, on a socket or not:
 * no reply for 10 s and it is dead (owner, 2026-10-23). A client pings or
 * frames each heartbeat, so only a dead one goes quiet that long.
 */
const LOST_BEATS = 2
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

export function createRelay(opts: RelayOptions): Relay {
  const heartbeatMs = opts.heartbeatMs ?? 5_000
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
  const saveParticipant = (run: Run, p: Participant): void => {
    store?.put(pAt(run, p.id), { role: p.role, info: p.info, seen: p.seen })
    p.saved = p.seen
  }

  /**
   * `capped` false: the relay's own notice (joined, lost, closed), queued
   * past a full queue. Refused, it threw out of a close or a sweep: the
   * workers after it never heard, the run was never forgotten, and the Bun
   * host's timer threw it out of the process (2026-10-23).
   */
  const deliver = (run: Run, p: Participant, m: Message, bytes = 0, capped = true): void => {
    if (p.socket !== undefined && p.queue.length === 0) {
      try {
        p.socket.send(JSON.stringify({ messages: [m] }))
        return
      } catch {
        unplug(p)
      }
    }
    if (capped && (p.queue.length >= MAX_QUEUE || p.bytes + bytes > MAX_QUEUE_BYTES)) {
      throw new HttpError(429, 'queue full')
    }
    if (p.queue.length === 0) store?.put(qAt(run, p.id), true)
    p.queue.push(m)
    p.bytes += bytes
  }

  /**
   * A socket a push failed on is closed, not only let go: left open, its
   * pings answered, its participant never redialed for what queued (two CI
   * runs hung 20 min, 2026-10-23).
   */
  const unplug = (p: Participant): void => {
    const s = p.socket
    p.socket = undefined
    try {
      if (s !== undefined) closeSocket(s)
    } catch {}
  }

  /** `socket` reaches the participant: what queued for it goes down it. */
  const plug = (run: Run, p: Participant, socket: RelaySocket): void => {
    p.socket = socket
    if (p.hello !== undefined) {
      try {
        socket.send(p.hello)
        delete p.hello
      } catch {
        unplug(p)
        return
      }
    }
    if (p.queue.length === 0) return
    const bytes = p.bytes
    const messages = drain(run, p)
    try {
      socket.send(JSON.stringify({ messages }))
    } catch {
      unplug(p)
      // Queued again as they were: delivered anew, their bytes were lost and
      // past the cap (the relay's own notices go over it) a 429 threw from here.
      p.queue = messages
      p.bytes = bytes
      store?.put(qAt(run, p.id), true)
    }
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
      if (p.role !== 'worker') continue
      deliver(run, p, { from: 'relay', body: { type: 'closed' } }, 0, false)
      drop(run, p, false)
    }
    // A run is live while its orchestrator is, and only a live one is kept:
    // a worker that comes or calls after it learns it at once (owner,
    // 2026-10-23: "job is live, or it isnt"). Kept closed, or opened by a
    // worker alone, a run held a late worker's runner ten minutes.
    forget(run)
  }

  /** `tell`: the orchestrator hears its worker was lost (not when it removed it). */
  const drop = (run: Run, p: Participant, tell = true): void => {
    if (!run.byId.delete(p.id)) return
    const left = drain(run, p)
    if (!tell) {
      // What queued, its `refused` among it, before the socket closes.
      if (left.length > 0) {
        try {
          p.socket?.send(JSON.stringify({ messages: left }))
        } catch {}
      }
    }
    store?.delete(pAt(run, p.id))
    store?.delete(qAt(run, p.id))
    // Its socket learns it is gone by the close code; its next socket, from `socket`.
    if (p.socket !== undefined) closeSocket(p.socket, GONE, 'gone')
    if (p.role === 'orchestrator') {
      close(run)
      return
    }
    if (tell && run.orchestrator !== undefined && !run.closed) {
      deliver(run, run.orchestrator, { from: 'relay', body: { type: 'lost', id: p.id } }, 0, false)
    }
  }

  /** The orchestrator takes a worker it did not admit off the run. */
  const removeWorker = (run: Run, p: Participant, worker: unknown): void => {
    const a = typeof worker === 'string' ? run.byId.get(worker) : undefined
    if (p.role !== 'orchestrator') throw new HttpError(403, 'only the orchestrator removes')
    if (a === undefined || a.role !== 'worker') throw new HttpError(404, 'unknown worker')
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
    if (run.closed) saveRun(run)
  }

  const forget = (run: Run): void => {
    runs.delete(run.key)
    empty(run)
    store?.delete(runAt(run.key))
  }

  const lostAfter = LOST_BEATS * heartbeatMs
  const sweep = (): number | undefined => {
    const now = Date.now()
    let next: number | undefined
    const at = (t: number): void => {
      next = Math.min(next ?? t, t)
    }
    for (const run of [...runs.values()]) {
      for (const p of [...run.byId.values()]) {
        if (now - p.seen > lostAfter) drop(run, p)
      }
      if (!runs.has(run.key)) continue
      if (run.orchestrator === undefined) close(run)
      else {
        for (const p of run.byId.values()) {
          // One on a socket is heard anew when its host restores the socket;
          // a write per participant per sweep spent a free host's 100 000
          // rows a day in about 40 CI runs (2026-10-23).
          if (p.socket === undefined && p.saved !== p.seen) saveParticipant(run, p)
          at(p.seen + lostAfter + 1)
        }
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
    const nonces = (run.nonces ??= new Map())
    for (const [n, at] of nonces) if (now - at > 2 * PROOF_SKEW_MS) nonces.delete(n)
    if (Math.abs(now - Number(ts)) > PROOF_SKEW_MS || nonces.has(nonce)) {
      throw new HttpError(403, 'not signed by the run’s orchestrator key')
    }
    // Taken before the await, so a replay sent alongside finds it taken.
    nonces.set(nonce, now)
    const key = cert === run.cert ? (run.certKey ??= importKey(cert)) : importKey(cert)
    const signed = proofText(req.method, url.pathname + url.search, Number(ts), nonce, body)
    if (!(await verifyProof(await key, sig, signed))) {
      throw new HttpError(403, 'not signed by the run’s orchestrator key')
    }
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
  ): Participant => {
    const role = body.role
    if (role !== 'orchestrator' && role !== 'worker') {
      throw new HttpError(400, 'role is orchestrator or worker')
    }
    if (role === 'orchestrator' && run.orchestrator !== undefined) {
      throw new HttpError(409, 'the run has an orchestrator')
    }
    const p: Participant = {
      id: crypto.randomUUID().replaceAll('-', ''),
      role,
      // No one reads the orchestrator's.
      info: role === 'worker' ? (body.info ?? null) : null,
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
        if (a.role === 'worker') {
          deliver(run, p, joined(a), 0, false)
          saveParticipant(run, a)
        }
      }
    } else if (run.orchestrator !== undefined) {
      deliver(run, run.orchestrator, joined(p), 0, false)
      saveParticipant(run, p)
    } else {
      // Held until an orchestrator joins to read it.
      saveParticipant(run, p)
    }
    return p
  }

  const send = (
    run: Run,
    from: Participant,
    body: { to?: unknown; body?: unknown },
    bytes: number,
  ): void => {
    const to =
      from.role === 'worker'
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

  const live = (key: string): Run => {
    const run = runs.get(key)
    if (run === undefined) missing()
    if (run.closed) throw new HttpError(410, 'run closed')
    return run
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const m = /^\/v1\/runs\/([^/]+)\/(join|socket)$/.exec(url.pathname)
    if (m === null) throw new HttpError(404, 'no such route')
    const [, runId, verb] = m as unknown as [string, string, string]
    if (!RUN_ID.test(runId)) throw new HttpError(400, 'run id is not a random UUID')
    if (req.method !== (verb === 'socket' ? 'GET' : 'POST')) {
      throw new HttpError(405, 'wrong method')
    }
    const token = await authorize(req, opts.verify)
    // A run is its id within its repository, so another tenant that learns
    // an id cannot open it first.
    const key = await runKey(runId, token)
    const run = runs.get(key)
    if (verb === 'socket') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        throw new HttpError(426, 'not a websocket')
      }
      const asked = url.searchParams.get('join')
      if (asked !== null) {
        const p = await enter(key, req, url, parse(asked), asked, token)
        p.hello = JSON.stringify({ joined: { id: p.id, heartbeatMs } })
        return opts.upgrade(key, p.id, req)
      }
      const id = url.searchParams.get('id') ?? ''
      // One the relay lost or let go learns it from the close code (GONE)
      // its host gives the socket attach refuses: a failed upgrade says nothing.
      if (run === undefined || run.closed || !run.byId.has(id)) return opts.upgrade(key, id, req)
      // As the orchestrator: in its CI job, and signed by the key it joined with.
      const p = participant(run, id, token)
      if (p.role === 'orchestrator') await prove(run, req, url, '')
      return opts.upgrade(key, p.id, req)
    }
    const [body, text] = await readBody(req)
    const p = await enter(key, req, url, body, text, token)
    return Response.json({ id: p.id, heartbeatMs, socket: true })
  }

  /**
   * Joins `body` to the run `key`: by a `join` request, or by the socket
   * that carries it (`text` signed in its query), one request fewer a
   * participant on a host that bills each.
   */
  const enter = async (
    key: string,
    req: Request,
    url: URL,
    body: Record<string, unknown>,
    text: string,
    token: VerifiedToken | undefined,
  ): Promise<Participant> => {
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
    if (body['role'] !== 'orchestrator' && body['role'] !== 'worker') {
      throw new HttpError(400, 'role is orchestrator or worker')
    }
    const run = runs.get(key)
    if (body['role'] === 'worker') {
      // Its orchestrator starts it: a worker finds it live, or leaves.
      if (run === undefined || run.closed) throw new HttpError(410, 'no live run')
      return join(run, body, token)
    }
    if (run !== undefined) throw new HttpError(409, 'the run has an orchestrator')
    const fresh: Run = { key, closed: false, byId: new Map(), openedAt: Date.now() }
    await prove(fresh, req, url, req.method === 'GET' ? '' : text, body['key'] as string)
    // Another orchestrator may have joined while the key was checked.
    if (runs.has(key)) throw new HttpError(409, 'the run has an orchestrator')
    runs.set(key, fresh)
    return join(fresh, body, token)
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
    attach(key, id, socket, heardAt) {
      const run = runs.get(key)
      const p = run?.closed === false ? run.byId.get(id) : undefined
      if (run === undefined || p === undefined) return false
      // One socket a participant. A host restoring several (a wake, a
      // redial whose old close it never ran) attached the last; a push
      // failing on a stale one unplugged it, and the live one, its pings
      // answered by the host, never heard again: main 32f73ed's
      // orchestrator waited 13 min on results queued here (2026-10-23).
      // Closed, the other's client dials again and gets what queued.
      if (p.socket !== undefined && p.socket !== socket) {
        try {
          closeSocket(p.socket)
        } catch {}
      }
      plug(run, p, socket)
      // A dead orchestrator's socket, restored at each wake, kept it alive
      // and its run's workers waited out their job's timeout (2026-10-23).
      p.seen = heardAt === undefined ? Date.now() : Math.max(p.seen, heardAt)
      return true
    },
    detach(key, id, socket) {
      const run = runs.get(key)
      const p = run?.byId.get(id)
      if (p === undefined || p.socket !== socket) return
      p.socket = undefined
      // Its workers go with it at once (owner, 2026-10-23: "if the
      // orchestrator is disconnected we close all agents").
      if (p.role === 'orchestrator') return drop(run!, p)
      // Its silence counts from now, though its host evicts this before the next sweep.
      saveParticipant(run!, p)
    },
    frame(key, id, text, socket) {
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
          leave?: unknown
          remove?: unknown
          sends?: unknown
        }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          throw new HttpError(400, 'frame is not JSON')
        }
        // `null` or an array read as a frame threw a TypeError out of the relay.
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new HttpError(400, 'frame is not a JSON object')
        n = body.n ?? null
        const run = live(key)
        const p = participant(run, id, 'socket')
        // It spoke down this socket, so this socket reaches it: one its
        // host let go or never restored as its own left it deaf while its
        // pings were answered, and 13baaf6's orchestrator heard nothing
        // for 8 min (2026-10-23). Not closing the other: a host may hand
        // the same socket as another object.
        if (socket !== undefined && p.socket !== socket) plug(run, p, socket)
        if (body.leave === true) drop(run, p)
        else if (body.remove !== undefined) removeWorker(run, p, body.remove)
        else if (Array.isArray(body.sends)) {
          // Several sends in one frame: one message the host bills, each answered.
          const results = body.sends.map((one: { to?: unknown; body?: unknown }) => {
            try {
              if (typeof one !== 'object' || one === null)
                throw new HttpError(400, 'a send is an object')
              send(run, p, one, JSON.stringify(one).length)
              return null
            } catch (err) {
              if (!(err instanceof HttpError)) throw err
              return { status: err.status, ...errorBody(err) }
            }
          })
          if (results.some((r) => r !== null)) return JSON.stringify({ n, results })
        } else throw new HttpError(400, 'frame is sends, remove or leave')
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
      saved: seen ?? now,
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
  return [parse(text), text]
}

function parse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>
  } catch {}
  throw new HttpError(400, 'body is not a JSON object')
}
