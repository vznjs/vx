// The relay of PROTOCOL.md: pushes each message between one orchestrator
// and its workers down the receiver's socket, or drops it; only its own
// notices wait. A relay restart ends the runs it carried, unless its host
// hands back the sockets it kept (a Durable Object's, across hibernation),
// each with what `attach` gave it to keep.
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
  /**
   * How often its participants hear from each other, said in each join's
   * answer: a peer quiet one is asked, and lost after two (vx-dte).
   */
  heartbeatMs?: number
  /**
   * The sockets its host kept across a restart, each with what `attach`
   * gave it to keep: the runs are rebuilt from them, and a run whose
   * orchestrator's socket is not among them is over.
   */
  sockets?: Iterable<readonly [Kept, RelaySocket]> | undefined
  /**
   * Answers a participant's `socket` request: the host accepts the
   * websocket and `attach`es it. A participant speaks only over it.
   */
  upgrade: (key: string, id: string, req: Request) => Response
}

/**
 * What a host keeps with a participant's socket (a Durable Object's
 * attachment, at most 2 KiB) so a restart rebuilds its run: no message.
 */
export interface Kept {
  key: string
  id: string
  role: 'orchestrator' | 'worker'
  /** The orchestrator's: its run's `pin` and `cert`. */
  pin?: string
  cert?: string
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
   * Pushes the participant's messages down `socket`; returns what its host
   * keeps with it, or false if it is gone.
   */
  attach(key: string, id: string, socket: RelaySocket): Kept | false
  /** The participant's socket closed: it is gone, and its peers are told. */
  detach(key: string, id: string, socket: RelaySocket): void
  /**
   * One frame a participant sent down `socket`, which becomes its socket;
   * returns the answer frame, if it gets one.
   */
  frame(key: string, id: string, text: string, socket?: RelaySocket): string | undefined
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
  /** Requests it may still make now, and when that was counted (a token bucket). */
  tokens: number
  filled: number
  /** The relay's own notices it could not push yet. */
  queue: Message[]
  socket?: RelaySocket | undefined
  /** A participant that joined on its socket: what that socket says first. */
  hello?: string
}

interface Run {
  key: string
  closed: boolean
  orchestrator?: Participant
  byId: Map<string, Participant>
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

  /**
   * Down the participant's socket, or nowhere: a participant's message the
   * relay cannot push now is dropped, and its sender, unacknowledged, sends
   * it again (NATS-style; the relay holds nothing a sender can resend). The
   * relay's own notices (`notice`: joined, lost, closed) have no sender to
   * resend them, so they wait for the next socket.
   */
  const deliver = (run: Run, p: Participant, m: Message, notice = false): void => {
    if (p.socket !== undefined && p.queue.length === 0) {
      try {
        p.socket.send(JSON.stringify({ messages: [m] }))
        return
      } catch {
        unplug(p)
      }
    }
    if (notice) p.queue.push(m)
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
    const messages = drain(p)
    try {
      socket.send(JSON.stringify({ messages }))
    } catch {
      unplug(p)
      p.queue = messages
    }
  }

  const drain = (p: Participant): Message[] => {
    const messages = p.queue
    p.queue = []
    return messages
  }

  const close = (run: Run): void => {
    run.closed = true
    for (const p of [...run.byId.values()]) {
      if (p.role !== 'worker') continue
      deliver(run, p, { from: 'relay', body: { type: 'closed' } }, true)
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
    const left = drain(p)
    if (!tell) {
      // What queued, its `refused` among it, before the socket closes.
      if (left.length > 0) {
        try {
          p.socket?.send(JSON.stringify({ messages: left }))
        } catch {}
      }
    }
    // Its socket learns it is gone by the close code; its next socket, from `socket`.
    if (p.socket !== undefined) closeSocket(p.socket, GONE, 'gone')
    if (p.role === 'orchestrator') {
      close(run)
      return
    }
    if (tell && run.orchestrator !== undefined && !run.closed) {
      deliver(run, run.orchestrator, { from: 'relay', body: { type: 'lost', id: p.id } }, true)
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
    for (const p of run.byId.values()) drain(p)
    run.byId.clear()
    delete run.orchestrator
    delete run.pin
    delete run.cert
    delete run.certKey
    delete run.nonces
  }

  const forget = (run: Run): void => {
    runs.delete(run.key)
    empty(run)
  }

  if (opts.sockets !== undefined) restore(opts.sockets, runs)

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
      tokens: RATE_BURST,
      filled: Date.now(),
      queue: [],
    }
    run.byId.set(p.id, p)
    if (p.role === 'orchestrator') {
      run.orchestrator = p
      run.cert = body.key as string
      if (token?.job !== undefined) run.pin = token.job
      for (const a of run.byId.values()) if (a.role === 'worker') deliver(run, p, joined(a), true)
    } else if (run.orchestrator !== undefined) deliver(run, run.orchestrator, joined(p), true)
    return p
  }

  const send = (run: Run, from: Participant, body: { to?: unknown; body?: unknown }): void => {
    const to =
      from.role === 'worker'
        ? body.to === 'orchestrator'
          ? run.orchestrator
          : undefined
        : typeof body.to === 'string'
          ? run.byId.get(body.to)
          : undefined
    if (to === undefined || to === from) throw new HttpError(404, 'unknown to')
    deliver(run, to, {
      from: from.role === 'orchestrator' ? 'orchestrator' : from.id,
      body: body.body,
    })
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
    const fresh: Run = { key, closed: false, byId: new Map() }
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
    attach(key, id, socket) {
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
      return {
        key,
        id,
        role: p.role,
        ...(p.role === 'orchestrator' && run.pin !== undefined ? { pin: run.pin } : {}),
        ...(p.role === 'orchestrator' && run.cert !== undefined ? { cert: run.cert } : {}),
      }
    },
    detach(key, id, socket) {
      const run = runs.get(key)
      const p = run?.byId.get(id)
      if (p === undefined || p.socket !== socket) return
      p.socket = undefined
      // Liveness is the connection (owner, 2026-10-23): its socket closed,
      // it is gone, and the orchestrator's workers go with it at once. A
      // peer quiet on a socket that never closed (no TCP end, no close) is
      // its peers' to lose (vx-dte probes it): the relay keeps no timer.
      drop(run!, p)
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
              send(run, p, one)
              return null
            } catch (err) {
              if (!(err instanceof HttpError)) throw err
              return { status: err.status, ...errorBody(err) }
            }
          })
          if (results.some((r) => r !== null)) return JSON.stringify({ n, results })
        } else throw new HttpError(400, 'frame is sends, remove or leave')
        // Unnumbered: its sender waits on no answer (an ack, a probe), so
        // only a failure is one.
        return n === null ? undefined : JSON.stringify({ n })
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        return JSON.stringify({ n, status: err.status, ...errorBody(err) })
      }
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
 * Runs as their sockets kept them. A run without its orchestrator's
 * socket is over (liveness is the connection), as is a socket kept by an
 * older relay: each is closed as gone. Of a participant's several, the
 * last is its socket.
 */
function restore(sockets: Iterable<readonly [Kept, RelaySocket]>, runs: Map<string, Run>): void {
  const all = [...sockets]
  for (const [k] of all) {
    if (k?.role !== 'orchestrator' || runs.has(k.key)) continue
    runs.set(k.key, {
      key: k.key,
      closed: false,
      byId: new Map(),
      ...(k.pin === undefined ? {} : { pin: k.pin }),
      ...(k.cert === undefined ? {} : { cert: k.cert }),
    })
  }
  const now = Date.now()
  for (const [k, socket] of all) {
    const run = k?.role === undefined ? undefined : runs.get(k.key)
    if (run === undefined) {
      closeSocket(socket, GONE, 'gone')
      continue
    }
    const before = run.byId.get(k.id)
    if (before?.socket !== undefined) closeSocket(before.socket)
    const p: Participant = before ?? {
      id: k.id,
      role: k.role,
      info: null,
      tokens: RATE_BURST,
      filled: now,
      queue: [],
    }
    p.socket = socket
    run.byId.set(k.id, p)
    if (k.role === 'orchestrator') run.orchestrator = p
  }
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
