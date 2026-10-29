// The relay of PROTOCOL.md: pushes each message between one host
// and its peers down the receiver's socket, or drops it; only its own
// notices wait. A relay restart ends the sessions it carried, unless its host
// hands back the sockets it kept (a Durable Object's, across hibernation),
// each with what `attach` gave it to keep.
// It knows as little as routing needs: a session is a hash, bodies and a
// peer's info are its peers' ciphertext, and no body is ever stored.

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
   * How long a participant whose socket dropped, without `leave`, may dial
   * again by its `id` before it is gone (default 10 000).
   */
  graceMs?: number
  /**
   * The sockets its host kept across a restart, each with what `attach`
   * gave it to keep: the sessions are rebuilt from them, and a session
   * none of whose sockets names its host is over.
   */
  sockets?: Iterable<readonly [Kept, RelaySocket]> | undefined
  /**
   * Answers a participant's `socket` request: the host accepts the
   * websocket and `attach`es it. A participant speaks only over it.
   */
  upgrade: (key: string, id: string, req: Request, protocol?: string) => Response
}

/** The websocket subprotocol a version of PROTOCOL.md is offered and chosen as. */
const PROTOCOL = 'switchboard.v'
/** The versions this relay speaks, oldest first. */
const VERSIONS = [1]
const SUPPORTED = `supported: ${PROTOCOL}${VERSIONS[0]}-v${VERSIONS.at(-1)}`

/**
 * The subprotocol a socket request is answered with: the highest version
 * both speak, else the first it offered, so its client reads the 4406
 * refusal (one answered with no subprotocol, or another, fails unread).
 */
export function negotiate(req: Request): { protocol?: string; version?: number } {
  const offered = (req.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
  let version: number | undefined
  for (const t of offered) {
    const v = t.startsWith(PROTOCOL) ? Number(t.slice(PROTOCOL.length)) : NaN
    if (VERSIONS.includes(v) && (version === undefined || v > version)) version = v
  }
  if (version !== undefined) return { protocol: `${PROTOCOL}${version}`, version }
  return offered[0] === undefined ? {} : { protocol: offered[0] }
}

/**
 * What a host keeps with a participant's socket (a Durable Object's
 * attachment, at most 2 KiB) so a restart rebuilds its session: no message.
 */
export interface Kept {
  key: string
  id: string
  role: 'host' | 'peer'
  /** Its session's `cert`: a session rebuilt from peers alone still proves its host. */
  cert?: string
  /** A peer's: its host's `id`, so a restart keeps a session whose host is dialing again. */
  host?: string
}

/** A participant's websocket, as its host holds it. */
export interface RelaySocket {
  send(text: string): void
  close(code?: number, reason?: string): void
}

/** The close code of a socket request refused with HTTP `status`. */
export const refusedWith = (status: number): number => 4000 + status

/** The close code of a socket whose participant the relay lost, let go, or never knew. */
export const GONE = refusedWith(404)

/**
 * Close `socket` with `code`, said first in a frame (`{ "close": code,
 * "error"? }`, 0 for none): Bun 1.4.4's client fires its close only once
 * the host ends TCP too, and workerd never did, so a lost peer heard
 * 4404 10 s late, at its own redial limit (PR #4171, 2026-10-23). A
 * refusal's code is 4000 plus its HTTP status, its `reason` the error.
 */
export function closeSocket(socket: RelaySocket, code?: number, reason?: string): void {
  try {
    socket.send(JSON.stringify({ close: code ?? 0, ...(reason ? { error: reason } : {}) }))
    // quiet: a socket that can carry nothing is closed all the same
  } catch {}
  // A close reason holds 123 bytes; the frame said it whole.
  socket.close(code, reason?.slice(0, 120))
}

export interface Relay {
  fetch(req: Request): Promise<Response>
  /**
   * Pushes the participant's messages down `socket`; returns what its host
   * keeps with it, or false if it is gone or its request was refused: the
   * relay has closed it, saying why.
   */
  attach(key: string, id: string, socket: RelaySocket): Kept | false
  /** The participant's socket closed: gone, unless it dials again within `graceMs`. */
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
  role: 'host' | 'peer'
  /** A peer's, until the host is told it joined. */
  info: unknown
  /** The relay's own notices it could not push yet. */
  queue: Message[]
  socket?: RelaySocket | undefined
  /** When its socket dropped with no `leave`, or it joined: it is gone `graceMs` on. */
  droppedAt?: number
  /** A participant that joined on its socket: what that socket says first. */
  hello?: string
}

interface Session {
  key: string
  closed: boolean
  host?: Participant
  byId: Map<string, Participant>
  /** The public key its host joined with; only its holder acts as it. */
  cert?: string
  certKey?: Promise<CryptoKey>
  /** Proof nonces seen, and when: each is taken once. */
  nonces?: Map<string, number>
}

/** A random (v4) UUID: no one can guess a session id to open it first or join it. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY = 1 << 20
/**
 * Over `MAX_BODY` bytes of UTF-8: a string's length counts UTF-16 units,
 * and a frame of 600 000 `é`s passed as 1.2 MB. Encoded only when it may be.
 */
const overMax = (text: string): boolean =>
  text.length > MAX_BODY ||
  (text.length * 3 > MAX_BODY && new TextEncoder().encode(text).byteLength > MAX_BODY)
/** How far a proof's time may be from the relay's: a CI runner's clock drifts. */
const PROOF_SKEW_MS = 2 * 60_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const errorBody = (err: HttpError | TokenError): object => ({ error: err.message })

export function createRelay(opts: RelayOptions): Relay {
  const heartbeatMs = opts.heartbeatMs ?? 2_000
  const graceMs = opts.graceMs ?? 10_000
  const sessions = new Map<string, Session>()

  /**
   * Down the participant's socket, or nowhere: a participant's message the
   * relay cannot push now is dropped, and its sender, unacknowledged, sends
   * it again (NATS-style; the relay holds nothing a sender can resend). The
   * relay's own notices (`notice`: joined, lost, closed) have no sender to
   * resend them, so they wait for the next socket.
   */
  const deliver = (session: Session, p: Participant, m: Message, notice = false): void => {
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
    p.droppedAt = Date.now()
    try {
      if (s !== undefined) closeSocket(s)
    } catch {}
  }

  /** `socket` reaches the participant: what queued for it goes down it. */
  const plug = (session: Session, p: Participant, socket: RelaySocket): void => {
    p.socket = socket
    delete p.droppedAt
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

  /**
   * `lost`: its host's grace passed, so it may still join again (a relay
   * restart forgot it, or its network dropped): each peer's socket closes
   * with no code, and its redial learns the session is gone and joins
   * again. Only a host's `leave` tells its peers `closed`, the end.
   */
  const close = (session: Session, lost = false): void => {
    session.closed = true
    for (const p of [...session.byId.values()]) {
      if (p.role !== 'peer') continue
      if (lost) {
        session.byId.delete(p.id)
        if (p.socket !== undefined) closeSocket(p.socket)
        continue
      }
      deliver(session, p, { from: 'relay', body: { type: 'closed' } }, true)
      drop(session, p, false)
    }
    // A session is live while its host is, and only a live one is kept:
    // a peer that comes or calls after it learns it at once
    // (2026-10-23: "job is live, or it isnt"). Kept closed, or opened by a
    // peer alone, a session held a late peer's runner ten minutes.
    forget(session)
  }

  /**
   * `tell`: the host hears its peer was lost (not when it removed it).
   * `lost`: its grace passed with no redial, rather than a `leave`.
   */
  const drop = (session: Session, p: Participant, tell = true, lost = false): void => {
    if (!session.byId.delete(p.id)) return
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
    if (p.role === 'host') {
      close(session, lost)
      return
    }
    if (tell && session.host !== undefined && !session.closed) {
      deliver(session, session.host, { from: 'relay', body: { type: 'left', id: p.id } }, true)
    }
  }

  /**
   * Its participants whose sockets dropped `graceMs` ago, and never came
   * back, are gone: checked as the session is next used, so the relay
   * keeps no timer. A peer's silence is lost by its host sooner (vx-dte).
   */
  const lapse = (session: Session): void => {
    const now = Date.now()
    for (const p of [...session.byId.values()]) {
      if (session.closed) return
      if (p.droppedAt !== undefined && now - p.droppedAt >= graceMs) drop(session, p, true, true)
    }
  }

  let swept = 0
  /**
   * Every session's lapsed participants, at most once a grace: a session
   * all of whose sockets dropped is used by no one again, and a relay
   * that keeps its sessions in memory alone (`serveRelay`) held it.
   */
  const sweep = (): void => {
    const now = Date.now()
    if (now - swept < graceMs) return
    swept = now
    for (const session of [...sessions.values()]) lapse(session)
  }

  /** The host takes a peer it did not admit off the session. */
  const removePeer = (session: Session, p: Participant, peer: unknown): void => {
    const a = typeof peer === 'string' ? session.byId.get(peer) : undefined
    if (p.role !== 'host') throw new HttpError(403, 'only the host removes')
    if (a === undefined || a.role !== 'peer') throw new HttpError(404, 'unknown peer')
    drop(session, a, false)
  }

  /** A closed session's participants, and what it knew of its host. */
  const empty = (session: Session): void => {
    for (const p of session.byId.values()) drain(p)
    session.byId.clear()
    delete session.host
    delete session.cert
    delete session.certKey
    delete session.nonces
  }

  const forget = (session: Session): void => {
    sessions.delete(session.key)
    empty(session)
  }

  if (opts.sockets !== undefined) restore(opts.sockets, sessions)
  for (const session of sessions.values()) lapse(session)

  /** The host's request is signed by the key it joined with, at most once. */
  const prove = async (
    session: Session,
    req: Request,
    url: URL,
    body: string,
    cert = session.cert,
  ) => {
    const m = /^(\d+)\.([\w-]{16,64})\.([\w-]+)$/.exec(req.headers.get(PROOF_HEADER) ?? '')
    if (m === null || cert === undefined) {
      throw new HttpError(403, 'not signed by the session’s host key')
    }
    const [, ts, nonce, sig] = m as unknown as [string, string, string, string]
    const now = Date.now()
    const nonces = (session.nonces ??= new Map())
    for (const [n, at] of nonces) if (now - at > 2 * PROOF_SKEW_MS) nonces.delete(n)
    if (Math.abs(now - Number(ts)) > PROOF_SKEW_MS || nonces.has(nonce)) {
      throw new HttpError(403, 'not signed by the session’s host key')
    }
    // Taken before the await, so a replay sent alongside finds it taken.
    nonces.set(nonce, now)
    const key = cert === session.cert ? (session.certKey ??= importKey(cert)) : importKey(cert)
    const signed = proofText(req.method, url.pathname + url.search, Number(ts), nonce, body)
    if (!(await verifyProof(await key, sig, signed))) {
      throw new HttpError(403, 'not signed by the session’s host key')
    }
  }

  const participant = (session: Session, id: unknown): Participant => {
    const p = typeof id === 'string' ? session.byId.get(id) : undefined
    if (p === undefined) throw new HttpError(404, 'unknown id')
    return p
  }

  const join = (
    session: Session,
    body: { role?: unknown; info?: unknown; key?: unknown },
  ): Participant => {
    const role = body.role
    if (role !== 'host' && role !== 'peer') {
      throw new HttpError(400, 'role is host or peer')
    }
    if (role === 'host' && session.host !== undefined) {
      throw new HttpError(409, 'the session has a host')
    }
    const p: Participant = {
      id: crypto.randomUUID().replaceAll('-', ''),
      role,
      // No one reads the host's.
      info: role === 'peer' ? (body.info ?? null) : null,
      queue: [],
      // Let in before its socket opens: a client gone in between never
      // opens it, and its host held the run for good (Bun's refused
      // upgrade too). Its socket's `attach` clears this.
      droppedAt: Date.now(),
    }
    session.byId.set(p.id, p)
    if (p.role === 'host') {
      session.host = p
      session.cert = body.key as string
      for (const a of session.byId.values())
        if (a.role === 'peer') deliver(session, p, joined(a), true)
    } else if (session.host !== undefined) deliver(session, session.host, joined(p), true)
    return p
  }

  const send = (
    session: Session,
    from: Participant,
    body: { to?: unknown; body?: unknown },
  ): void => {
    const to =
      from.role === 'peer'
        ? body.to === 'host'
          ? session.host
          : undefined
        : typeof body.to === 'string'
          ? session.byId.get(body.to)
          : undefined
    if (to === undefined || to === from) throw new HttpError(404, 'unknown to')
    deliver(session, to, {
      from: from.role === 'host' ? 'host' : from.id,
      body: body.body,
    })
  }

  const live = (key: string): Session => {
    const session = sessions.get(key)
    if (session === undefined) missing()
    if (session.closed) throw new HttpError(410, 'session closed')
    return session
  }

  /** Refusals of socket requests, by the id their host attaches the socket as. */
  const refusals = new Map<string, HttpError | TokenError>()

  /**
   * A participant speaks only over its socket, and joins as it opens one
   * (`socket?join=`): one request a participant on a host that bills each.
   */
  const handle = async (
    req: Request,
    protocol: string | undefined,
    version: number | undefined,
  ) => {
    sweep()
    const url = new URL(req.url)
    const m = /^\/v1\/sessions\/([^/]+)\/socket$/.exec(url.pathname)
    if (m === null)
      throw new HttpError(
        404,
        `no route ${req.method} ${url.pathname.slice(0, 200)}: the relay serves GET /v1/sessions/<id>/socket (PROTOCOL.md)`,
      )
    const sessionId = m[1]!
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'session id is not a random UUID')
    if (req.method !== 'GET') throw new HttpError(405, 'this route takes GET')
    const token = await authorize(req, opts.verify)
    // A session is its id within its repository, so another tenant that learns
    // an id cannot open it first.
    const key = await sessionKey(sessionId, token)
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(426, 'not a websocket')
    }
    if (version === undefined) throw new HttpError(406, SUPPORTED)
    const asked = url.searchParams.get('join')
    if (asked !== null) {
      if (overMax(asked)) throw new HttpError(413, 'join over 1 MiB')
      const p = await enter(key, req, url, parse(asked))
      p.hello = JSON.stringify({ joined: { id: p.id, heartbeatMs } })
      const res = opts.upgrade(key, p.id, req, protocol)
      // No socket will ever attach it, so no drop time would lapse it: a
      // host's session kept refusing every later host 409.
      if (res.status !== 101) {
        const session = sessions.get(key)
        if (session !== undefined) drop(session, p, true, true)
      }
      return res
    }
    const session = sessions.get(key)
    if (session !== undefined) lapse(session)
    const id = url.searchParams.get('id') ?? ''
    // One the relay lost or let go learns it from the close code (GONE)
    // `attach` closes the socket with.
    if (session === undefined || session.closed || !session.byId.has(id))
      return opts.upgrade(key, id, req, protocol)
    // As the host: signed by the key it joined with.
    if (participant(session, id).role === 'host') await prove(session, req, url, '')
    return opts.upgrade(key, id, req, protocol)
  }

  /** Joins `body` to the session `key`, by the socket that carries it, signed in its query. */
  const enter = async (
    key: string,
    req: Request,
    url: URL,
    body: Record<string, unknown>,
  ): Promise<Participant> => {
    if (body['role'] === 'host') {
      if (
        typeof body['key'] !== 'string' ||
        !(await importKey(body['key']).then(
          () => true,
          () => false,
        ))
      ) {
        throw new HttpError(400, 'a host joins with key: its P-256 public key')
      }
    }
    if (body['role'] !== 'host' && body['role'] !== 'peer') {
      throw new HttpError(400, 'role is host or peer')
    }
    const found = sessions.get(key)
    if (found !== undefined) lapse(found)
    const session = sessions.get(key)
    if (body['role'] === 'peer') {
      // Its host starts it: a peer finds it live, or leaves.
      if (session === undefined || session.closed) throw new HttpError(410, 'no live session')
      return join(session, body)
    }
    if (session !== undefined) throw new HttpError(409, 'the session has a host')
    const fresh: Session = { key, closed: false, byId: new Map() }
    await prove(fresh, req, url, '', body['key'] as string)
    // Another host may have joined while the key was checked.
    if (sessions.has(key)) throw new HttpError(409, 'the session has a host')
    sessions.set(key, fresh)
    return join(fresh, body)
  }

  return {
    async fetch(req) {
      const { protocol, version } = negotiate(req)
      try {
        return await handle(req, protocol, version)
      } catch (err) {
        if (!(err instanceof HttpError || err instanceof TokenError)) throw err
        // A failed upgrade tells a client nothing it can read: a socket
        // request is let in, and its socket closed saying why.
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const id = `refused-${crypto.randomUUID()}`
          refusals.set(id, err)
          const res = opts.upgrade('', id, req, protocol)
          // Never attached, it would be held for good: one per request, no token needed.
          if (res.status !== 101) refusals.delete(id)
          return res
        }
        // The one route takes GET: a 405 names it, as HTTP has it.
        const allow = err.status === 405 ? { headers: { allow: 'GET' } } : {}
        return Response.json(errorBody(err), { status: err.status, ...allow })
      }
    },
    attach(key, id, socket) {
      const refused = refusals.get(id)
      if (refused !== undefined) {
        refusals.delete(id)
        closeSocket(socket, refusedWith(refused.status), refused.message)
        return false
      }
      const session = sessions.get(key)
      const p = session?.closed === false ? session.byId.get(id) : undefined
      if (session === undefined || p === undefined) {
        closeSocket(socket, GONE, 'gone')
        return false
      }
      // One socket a participant. A host restoring several (a wake, a
      // redial whose old close it never ran) attached the last; a push
      // failing on a stale one unplugged it, and the live one, its pings
      // answered by the host, never heard again: main 32f73ed's
      // host waited 13 min on results queued here (2026-10-23).
      // Closed, the other's client dials again and gets what queued.
      const earlier = p.socket
      // Plugged first: Bun runs the earlier socket's close handler inside
      // its close(), and that detach lost the participant (a redial on
      // the Bun relay ended its peer).
      plug(session, p, socket)
      if (earlier !== undefined && earlier !== socket) {
        try {
          closeSocket(earlier)
        } catch {}
      }
      return {
        key,
        id,
        role: p.role,
        ...(session.cert !== undefined ? { cert: session.cert } : {}),
        ...(p.role === 'peer' && session.host !== undefined ? { host: session.host.id } : {}),
      }
    },
    detach(key, id, socket) {
      const session = sessions.get(key)
      const p = session?.byId.get(id)
      if (p === undefined || p.socket !== socket) return
      p.socket = undefined
      // Only `leave` ends a participant at once (2026-10-25): one
      // whose socket dropped dials again within `graceMs`, and its session,
      // a host's too, waits. Main 8d0619f's host socket ended 1006 and its
      // redial 350 ms on found the session closed (2026-10-24). A peer
      // quiet on a socket that never closed is its peers' to lose (vx-dte
      // probes it).
      p.droppedAt = Date.now()
    },
    frame(key, id, text, socket) {
      let n: unknown = null
      try {
        if (overMax(text)) {
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
        const found = live(key)
        lapse(found)
        const session = live(key)
        const p = participant(session, id)
        // It spoke down this socket, so this socket reaches it: one its
        // host let go or never restored as its own left it deaf while its
        // pings were answered, and 13baaf6's host heard nothing
        // for 8 min (2026-10-23). Not closing the other: a host may hand
        // the same socket as another object.
        if (socket !== undefined && p.socket !== socket) plug(session, p, socket)
        if (body.leave === true) drop(session, p)
        else if (body.remove !== undefined) removePeer(session, p, body.remove)
        else if (Array.isArray(body.sends)) {
          // Several sends in one frame: one message the host bills, each answered.
          const results = body.sends.map((one: { to?: unknown; body?: unknown }) => {
            try {
              if (typeof one !== 'object' || one === null)
                throw new HttpError(400, 'a send is an object')
              send(session, p, one)
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

/** Tells the host `a` joined, and forgets what it said. */
const joined = (a: Participant): Message => {
  const info = a.info
  a.info = null
  return { from: 'relay', body: { type: 'joined', id: a.id, info } }
}

/**
 * Sessions as their sockets kept them. A session whose host's socket was
 * not kept waits for its host's redial from now (`graceMs`), if a peer's
 * socket names it; one none names is over, as is a socket kept by an older
 * relay: each is closed as gone. Of a participant's several, the last is
 * its socket.
 */
function restore(
  sockets: Iterable<readonly [Kept, RelaySocket]>,
  sessions: Map<string, Session>,
): void {
  const all = [...sockets]
  for (const [k] of all) {
    const host = k?.role === 'host' ? k.id : k?.host
    if (host === undefined) continue
    let session = sessions.get(k.key)
    if (session === undefined) {
      session = {
        key: k.key,
        closed: false,
        byId: new Map(),
        ...(k.cert === undefined ? {} : { cert: k.cert }),
      }
      sessions.set(k.key, session)
    }
    if (session.host === undefined) {
      const p: Participant = {
        id: host,
        role: 'host',
        info: null,
        queue: [],
        droppedAt: Date.now(),
      }
      session.host = p
      session.byId.set(host, p)
    }
  }
  for (const [k, socket] of all) {
    const session = k?.role === undefined ? undefined : sessions.get(k.key)
    if (session === undefined) {
      closeSocket(socket, GONE, 'gone')
      continue
    }
    const before = session.byId.get(k.id)
    if (before?.socket !== undefined) closeSocket(before.socket)
    const p: Participant = before ?? {
      id: k.id,
      role: k.role,
      info: null,
      queue: [],
    }
    p.socket = socket
    delete p.droppedAt
    session.byId.set(k.id, p)
  }
}

function missing(): never {
  throw new HttpError(404, 'unknown session')
}

/**
 * The session's name: a SHA-256 of its id and the issuer and session claims of its
 * tokens, so neither storage nor a Durable Object's name says whose it is.
 */
export async function sessionKey(
  sessionId: string,
  token: VerifiedToken | undefined,
): Promise<string> {
  const name = token === undefined ? sessionId : [token.iss, ...token.run, sessionId].join('\0')
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

function parse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>
  } catch {}
  throw new HttpError(400, 'body is not a JSON object')
}
