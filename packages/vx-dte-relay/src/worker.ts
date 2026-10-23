// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's mailboxes live in one place and its held polls answer there.
// Participants hold websockets the object hibernates between messages: its
// state is in its storage, and an alarm, not a timer, finds the silent.
// `wrangler.jsonc` deploys it; ALLOW is a secret the deployer sets.

import { claimedRun, createVerifier, parseAllow } from './oidc.js'
import { createRelay, GONE, runKey, type Relay, type RelayStore } from './relay.js'

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
  serializeAttachment(v: Attachment): void
  deserializeAttachment(): Attachment
}
interface Attachment {
  key: string
  id: string
}
export interface DurableObjectState {
  readonly storage: {
    readonly kv: RelayStore
    getAlarm(): Promise<number | null>
    setAlarm(at: number): Promise<void>
    deleteAlarm(): Promise<void>
    deleteAll(): Promise<void>
  }
  acceptWebSocket(ws: Socket): void
  getWebSockets(): Socket[]
  setWebSocketAutoResponse(pair: unknown): void
  getWebSocketAutoResponseTimestamp(ws: Socket): Date | null
}
declare const caches: {
  default: {
    match(url: string): Promise<Response | undefined>
    put(url: string, res: Response): Promise<void>
  }
}
declare const WebSocketPair: new () => { 0: Socket; 1: Socket }
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown

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

/** Verifiers by ALLOW and audience, shared by the runs of one isolate. */
const verifiers = new Map<string, ReturnType<typeof createVerifier>>()

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const run = RUN.exec(new URL(req.url).pathname)?.[1]
    if (run === undefined) return Response.json({ error: 'no such route' }, { status: 404 })
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
  /** The alarm set; `undefined` until read from storage. */
  private alarmAt: number | null | undefined

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
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
      store: state.storage.kv,
      timer: false,
      upgrade: (key, id) => {
        const pair = new WebSocketPair()
        state.acceptWebSocket(pair[1])
        pair[1].serializeAttachment({ key, id })
        if (!this.relay.attach(key, id, pair[1])) pair[1].close(GONE, 'gone')
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
      },
    })
    // The runtime answers a participant's heartbeat without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    for (const ws of state.getWebSockets()) {
      const { key, id } = ws.deserializeAttachment()
      if (!this.relay.attach(key, id, ws)) ws.close(GONE, 'gone')
    }
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.relay.fetch(req)
    } finally {
      this.alarmAt ??= await this.state.storage.getAlarm()
      // A run its orchestrator signed off goes now, not at the next alarm.
      this.heard()
      if (this.relay.sweep() === undefined) await this.end()
      else if (this.alarmAt === null) {
        this.alarmAt = Date.now()
        await this.state.storage.setAlarm(this.alarmAt)
      }
    }
  }

  webSocketMessage(ws: Socket, message: string | ArrayBuffer): void {
    const { key, id } = ws.deserializeAttachment()
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const answer = this.relay.frame(key, id, text)
    // A `leave` closed the socket it came down: its close is the answer.
    try {
      ws.send(answer)
    } catch {}
  }

  webSocketClose(ws: Socket): void {
    const { key, id } = ws.deserializeAttachment()
    this.relay.detach(key, id, ws)
  }

  webSocketError(ws: Socket): void {
    this.webSocketClose(ws)
  }

  async alarm(): Promise<void> {
    this.heard()
    const next = this.relay.sweep()
    if (next === undefined) return this.end()
    this.alarmAt = next
    await this.state.storage.setAlarm(next)
  }

  /** Each socket's last ping, which the runtime answered without waking it. */
  private heard(): void {
    for (const ws of this.state.getWebSockets()) {
      const at = this.state.getWebSocketAutoResponseTimestamp(ws)
      const { key, id } = ws.deserializeAttachment()
      if (at !== null) this.relay.seen(key, id, at.getTime())
    }
  }

  /** No run is left: the object keeps nothing, so its host can drop it. */
  private async end(): Promise<void> {
    if (this.alarmAt !== null) await this.state.storage.deleteAlarm()
    this.alarmAt = null
    await this.state.storage.deleteAll()
  }
}
