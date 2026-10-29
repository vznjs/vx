// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's sockets meet in one place. Participants hold websockets the object
// hibernates between messages: its state is in their attachments, and it
// writes no storage. It keeps no alarm: a socket's close loses its
// participant.
// `wrangler.jsonc` deploys it; ALLOW is a var in it.

import { createVerifier, parseAllow, TokenError, type VerifiedToken } from './oidc.js'
import {
  closeSocket,
  createRelay,
  GONE,
  negotiate,
  refusedWith,
  sessionKey,
  type Kept,
  type Relay,
} from './relay.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>
}
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}
interface Socket {
  accept(): void
  send(text: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(v: Kept): void
  /** Null on one `attach` closed: it kept nothing. */
  deserializeAttachment(): Kept | null
}
export interface DurableObjectState {
  acceptWebSocket(ws: Socket): void
  getWebSockets(): Socket[]
}
declare const caches: {
  default: {
    match(url: string): Promise<Response | undefined>
    put(url: string, res: Response): Promise<void>
  }
}
declare const WebSocketPair: new () => { 0: Socket; 1: Socket }

export interface Env {
  readonly RELAY?: DurableObjectNamespace
  /** Who may take part (`parseAllow`): `issuer:owner/repo:workflow`, space separated. */
  readonly ALLOW?: string
  /** The `aud` every token must name; unset, the URL the relay is reached at. */
  readonly AUDIENCE?: string
}

const SESSION = /^\/v1\/sessions\/([^/]+)\//

/** How long the data center's cache holds an issuer's keys for the next isolate. */
const KEYS_TTL_S = 600

/**
 * An issuer's keys, read through the data center's cache: each run is its
 * own object, often in a fresh isolate, and each read the issuer twice per
 * join (2026-10-22). A key it does not hold is read past the cache.
 */
async function fetchJson(url: string, fresh: boolean): Promise<unknown> {
  const hit = fresh ? undefined : await caches.default.match(url)
  if (hit !== undefined) return hit.json()
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const body = await res.text()
  await caches.default.put(
    url,
    new Response(body, { headers: { 'cache-control': `max-age=${KEYS_TTL_S}` } }),
  )
  return JSON.parse(body)
}

/** What is wrong with an ALLOW, read once per value. */
let allowChecked: { allow: string | undefined; why: string | undefined } | undefined

/**
 * Why no run can join under `allow`, or `undefined`. A 403, not the 503 an
 * object that will not start gives: a client retries a 5xx, and this
 * refusal does not pass (2026-10-23: fail quickly).
 */
function allowRefusal(allow: string | undefined): string | undefined {
  if (allowChecked !== undefined && allowChecked.allow === allow) return allowChecked.why
  let why: string | undefined
  try {
    if (parseAllow(allow ?? '').length === 0) why = "this relay's ALLOW is empty: it admits no run"
  } catch (err) {
    why = `this relay's ALLOW: ${(err as Error).message}`
  }
  allowChecked = { allow, why }
  return why
}

/**
 * A refusal: a socket request is let in and its socket closed saying why,
 * as the relay does (a failed upgrade tells a client nothing it can read).
 */
function refuse(req: Request, status: number, error: string): Response {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error }, { status })
  }
  const pair = new WebSocketPair()
  pair[1].accept()
  closeSocket(pair[1], refusedWith(status), error)
  return upgraded(pair[0], negotiate(req).protocol)
}

/** The `101` handing the client its end of `socket`, naming the subprotocol chosen. */
function upgraded(socket: Socket, protocol: string | undefined): Response {
  return new Response(null, {
    status: 101,
    webSocket: socket,
    ...(protocol === undefined ? {} : { headers: { 'sec-websocket-protocol': protocol } }),
  } as ResponseInit)
}

/** Verifiers by ALLOW and audience, shared by the runs of one isolate. */
const verifiers = new Map<string, ReturnType<typeof createVerifier>>()

/**
 * The verifier of a request's token. The worker's URL is not known before
 * its first deploy; a token for another one is not meant for this relay.
 */
function verifierOf(env: Env, req: Request): ReturnType<typeof createVerifier> {
  // jose matches aud exactly: a pasted newline refused every token.
  const audience = env.AUDIENCE?.trim() || new URL(req.url).origin
  const key = `${env.ALLOW}\0${audience}`
  let v = verifiers.get(key)
  if (v === undefined) {
    v = createVerifier({ allow: parseAllow(env.ALLOW ?? ''), audience, fetchJson })
    verifiers.set(key, v)
  }
  return v
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const session = SESSION.exec(new URL(req.url).pathname)?.[1]
    if (session === undefined) {
      const error = `no route ${req.method} ${new URL(req.url).pathname.slice(0, 200)}: the relay serves GET /v1/sessions/<id>/socket (PROTOCOL.md)`
      return Response.json({ error }, { status: 404 })
    }
    const refused = allowRefusal(env.ALLOW)
    if (refused !== undefined) return refuse(req, 403, refused)
    // A blank one was the audience itself: every token was "wrong audience".
    if (env.AUDIENCE !== undefined && env.AUDIENCE.trim() === '')
      return refuse(req, 403, "this relay's AUDIENCE: the aud CI tokens name, or unset, not blank")
    if (env.RELAY === undefined) {
      return refuse(
        req,
        403,
        'RELAY: bind the RelayRun Durable Object as RELAY (wrangler.jsonc durable_objects)',
      )
    }
    // Checked here, before any object: each one a request wakes is billed,
    // and a host's daily limit then refuses every run, so a request with
    // no good token spent the relay's quota.
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (token === undefined) return refuse(req, 401, 'no bearer token')
    let run: VerifiedToken
    try {
      run = await verifierOf(env, req)(token)
    } catch (err) {
      if (!(err instanceof TokenError)) throw err
      return refuse(req, err.status, err.message)
    }
    const stub = env.RELAY.get(env.RELAY.idFromName(await sessionKey(session, run)))
    try {
      return await stub.fetch(req)
    } catch (err) {
      // The host refused the object (a plan's daily limit, an outage): a
      // bare 500 told a failed run nothing (2026-10-22).
      const why = err instanceof Error ? err.message : String(err)
      return refuse(req, 503, `the relay's host refused the run: ${why}`)
    }
  },
}

/** One run's relay. */
export class RelayRun {
  private readonly relay: Relay

  constructor(state: DurableObjectState, env: Env) {
    let allow: ReturnType<typeof parseAllow>
    try {
      allow = parseAllow(env.ALLOW ?? '')
    } catch (err) {
      throw new Error(`vx-dte-server: ALLOW: ${(err as Error).message}`)
    }
    if (allow.length === 0) throw new Error('vx-dte-server: set ALLOW')
    this.relay = createRelay({
      verify: (token, req) => verifierOf(env, req)(token),
      // One `attach` closed kept nothing: it is gone.
      sockets: state.getWebSockets().flatMap((ws) => {
        const kept = ws.deserializeAttachment()
        if (kept === null) closeSocket(ws, GONE, 'gone')
        return kept === null ? [] : [[kept, ws] as const]
      }),
      upgrade: (key, id, _req, protocol) => {
        const pair = new WebSocketPair()
        state.acceptWebSocket(pair[1])
        const kept = this.relay.attach(key, id, pair[1])
        if (kept !== false) pair[1].serializeAttachment(kept)
        return upgraded(pair[0], protocol)
      },
    })
  }

  fetch(req: Request): Promise<Response> {
    return this.relay.fetch(req)
  }

  webSocketMessage(ws: Socket, message: string | ArrayBuffer): void {
    const kept = ws.deserializeAttachment()
    if (kept === null) return
    const { key, id } = kept
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const answer = this.relay.frame(key, id, text, ws)
    // A `leave` closed the socket it came down: its close is the answer.
    try {
      if (answer !== undefined) ws.send(answer)
    } catch {}
    // quiet: a socket that cannot send has closed; its close is the answer
  }

  webSocketClose(ws: Socket): void {
    // One `attach` closed as gone kept nothing: its close threw (main
    // 8d0619f's redial, 2026-10-24).
    const kept = ws.deserializeAttachment()
    if (kept !== null) this.relay.detach(kept.key, kept.id, ws)
  }

  webSocketError(ws: Socket): void {
    this.webSocketClose(ws)
  }
}
