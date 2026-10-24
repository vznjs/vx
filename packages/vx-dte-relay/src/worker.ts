// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's sockets meet in one place. Participants hold websockets the object
// hibernates between messages: its state is in their attachments, and it
// writes no storage. It keeps no alarm: a socket's close loses its
// participant.
// `wrangler.jsonc` deploys it; ALLOW is a var in it.

import { claimedRun, createVerifier, parseAllow } from './oidc.js'
import { closeSocket, createRelay, GONE, runKey, type Kept, type Relay } from './relay.js'

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
  send(text: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(v: Kept): void
  deserializeAttachment(): Kept
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
  readonly RELAY: DurableObjectNamespace
  /** Who may take part (`parseAllow`): `issuer:owner/repo:workflow`, space separated. */
  readonly ALLOW?: string
  /** The `aud` every token must name; unset, the URL the relay is reached at. */
  readonly AUDIENCE?: string
}

const RUN = /^\/v1\/runs\/([^/]+)\//

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
 * refusal does not pass (owner, 2026-10-23: fail quickly).
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

/** Verifiers by ALLOW and audience, shared by the runs of one isolate. */
const verifiers = new Map<string, ReturnType<typeof createVerifier>>()

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const run = RUN.exec(new URL(req.url).pathname)?.[1]
    if (run === undefined) return Response.json({ error: 'no such route' }, { status: 404 })
    const refused = allowRefusal(env.ALLOW)
    if (refused !== undefined) return Response.json({ error: refused }, { status: 403 })
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    const claimed = token === undefined ? undefined : claimedRun(token)
    const stub = env.RELAY.get(env.RELAY.idFromName(await runKey(run, claimed)))
    try {
      return await stub.fetch(req)
    } catch (err) {
      // The host refused the object (a plan's daily limit, an outage): a
      // bare 500 told a failed run nothing (2026-10-22).
      const why = err instanceof Error ? err.message : String(err)
      return Response.json({ error: `the relay's host refused the run: ${why}` }, { status: 503 })
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
      throw new Error(`vx-dte-relay: ALLOW: ${(err as Error).message}`)
    }
    if (allow.length === 0) throw new Error('vx-dte-relay: set ALLOW')
    // The worker's URL is not known before its first deploy; a token for
    // another one is not meant for this relay.
    const verifierOf = (audience: string): ReturnType<typeof createVerifier> => {
      const key = `${env.ALLOW}\0${audience}`
      let v = verifiers.get(key)
      if (v === undefined) {
        v = createVerifier({ allow, audience, fetchJson })
        verifiers.set(key, v)
      }
      return v
    }
    this.relay = createRelay({
      verify: (token, req) => verifierOf(env.AUDIENCE || new URL(req.url).origin)(token),
      sockets: state.getWebSockets().map((ws) => [ws.deserializeAttachment(), ws] as const),
      upgrade: (key, id) => {
        const pair = new WebSocketPair()
        state.acceptWebSocket(pair[1])
        const kept = this.relay.attach(key, id, pair[1])
        if (kept === false) closeSocket(pair[1], GONE, 'gone')
        else pair[1].serializeAttachment(kept)
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
      },
    })
  }

  fetch(req: Request): Promise<Response> {
    return this.relay.fetch(req)
  }

  webSocketMessage(ws: Socket, message: string | ArrayBuffer): void {
    const { key, id } = ws.deserializeAttachment()
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const answer = this.relay.frame(key, id, text, ws)
    // A `leave` closed the socket it came down: its close is the answer.
    try {
      if (answer !== undefined) ws.send(answer)
    } catch {}
  }

  webSocketClose(ws: Socket): void {
    const { key, id } = ws.deserializeAttachment()
    this.relay.detach(key, id, ws)
  }

  webSocketError(ws: Socket): void {
    this.webSocketClose(ws)
  }
}
