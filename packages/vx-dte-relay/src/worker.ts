// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's mailboxes live in one place and its held polls answer there.
// Participants hold websockets the object hibernates between messages: its
// state is in its storage, and an alarm, not a timer, finds the silent.
// `wrangler.jsonc` deploys it; set ALLOW.

import { claimedRun, createVerifier, parseAllow } from './oidc.js'
import { createRelay, runKey, type Relay, type RelayStore } from './relay.js'

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
  close(): void
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
    deleteAll(): Promise<void>
  }
  acceptWebSocket(ws: Socket): void
  getWebSockets(): Socket[]
  setWebSocketAutoResponse(pair: unknown): void
  getWebSocketAutoResponseTimestamp(ws: Socket): Date | null
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const run = RUN.exec(new URL(req.url).pathname)?.[1]
    if (run === undefined) return Response.json({ error: 'no such route' }, { status: 404 })
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    const claimed = token === undefined ? undefined : claimedRun(token)
    return env.RELAY.get(env.RELAY.idFromName(await runKey(run, claimed))).fetch(req)
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
    const verifiers = new Map<string, ReturnType<typeof createVerifier>>()
    const verifierOf = (audience: string): ReturnType<typeof createVerifier> => {
      let v = verifiers.get(audience)
      if (v === undefined) {
        v = createVerifier({ allow, audience })
        verifiers.set(audience, v)
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
        this.relay.attach(key, id, pair[1])
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
      },
    })
    // The runtime answers a participant's heartbeat without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    for (const ws of state.getWebSockets()) {
      const { key, id } = ws.deserializeAttachment()
      if (!this.relay.attach(key, id, ws)) ws.close()
    }
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.relay.fetch(req)
    } finally {
      this.alarmAt ??= await this.state.storage.getAlarm()
      if (this.alarmAt === null) {
        this.alarmAt = Date.now()
        await this.state.storage.setAlarm(this.alarmAt)
      }
    }
  }

  webSocketMessage(ws: Socket, message: string | ArrayBuffer): void {
    const { key, id } = ws.deserializeAttachment()
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    ws.send(this.relay.frame(key, id, text))
  }

  webSocketClose(ws: Socket): void {
    const { key, id } = ws.deserializeAttachment()
    this.relay.detach(key, id, ws)
  }

  webSocketError(ws: Socket): void {
    this.webSocketClose(ws)
  }

  async alarm(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      const at = this.state.getWebSocketAutoResponseTimestamp(ws)
      const { key, id } = ws.deserializeAttachment()
      if (at !== null) this.relay.seen(key, id, at.getTime())
    }
    const next = this.relay.sweep()
    this.alarmAt = next ?? null
    if (next === undefined) await this.state.storage.deleteAll()
    else await this.state.storage.setAlarm(next)
  }
}
