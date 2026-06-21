import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.js'
import {
  err,
  isRequest,
  notify,
  ok,
  RpcErrorCode,
  type Envelope,
  type WireEvent,
} from './wire.js'

// One DO per active run. Holds:
//   - the graph + ready queue (TODO: lifted from src/orchestrator)
//   - registered workers (their WS connections, via Hibernation)
//   - the live WireEvent log (appended to D1 + R2 via the EVENT_INGEST queue)
//   - a set of subscriber WS connections (UI + cloud insights)
//
// WS Hibernation pattern: we use ctx.acceptWebSocket(ws) instead of ws.accept()
// so the runtime can hibernate the DO between messages. When a frame arrives
// the runtime rehydrates this object and calls webSocketMessage. State lives
// in ctx.storage; in-memory fields are lazy caches.

type RunMeta = {
  runId: string
  orgId: string
  startedAt: number
  status: 'pending' | 'running' | 'ended'
}

export class RunCoordinatorDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 })
      }
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      // WS Hibernation: accept via ctx, not ws.accept(); the DO can sleep.
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (url.pathname === '/append' && request.method === 'POST') {
      const event = (await request.json()) as WireEvent
      await this.appendEvent(event)
      return Response.json({ ok: true })
    }
    if (url.pathname === '/snapshot') {
      return Response.json(await this.snapshot())
    }
    return new Response('not found', { status: 404 })
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let envelope: Envelope
    try {
      envelope = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      ws.send(JSON.stringify(err(null, RpcErrorCode.ParseError, 'invalid JSON')))
      return
    }

    if (!isRequest(envelope)) return // notifications: nothing to reply

    const { id, method, params } = envelope
    switch (method) {
      case 'submit.run': {
        // Persist the run in storage; the per-task fan-out via inflight-
        // dedup DOs lands as a follow-up — the contract is here and
        // matches the local in-process executor.
        const p = (params ?? {}) as { runId?: string; orgId?: string; tasks?: string[] }
        const runId = p.runId ?? this.ctx.id.toString()
        const orgId = p.orgId ?? 'unknown'
        await this.ctx.storage.put<RunMeta>('meta', {
          runId,
          orgId,
          startedAt: Date.now(),
          status: 'running',
        })
        ws.send(JSON.stringify(ok(id, { accepted: true, runId })))
        return
      }
      case 'state.snapshot':
        ws.send(JSON.stringify(ok(id, await this.snapshot())))
        return
      case 'events.append': {
        await this.appendEvent(params as WireEvent)
        ws.send(JSON.stringify(ok(id, { ok: true })))
        return
      }
      case 'run.end': {
        const meta = await this.snapshot()
        if (meta) {
          await this.ctx.storage.put<RunMeta>('meta', { ...meta, status: 'ended' })
        }
        ws.send(JSON.stringify(ok(id, { ok: true })))
        return
      }
      default:
        ws.send(JSON.stringify(err(id, RpcErrorCode.MethodNotFound, `unknown method: ${method}`)))
    }
    // WS Hibernation: returning from webSocketMessage allows the DO to sleep
    // until the next frame. No backgrounded work on `this` survives.
  }

  override async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    // No-op: ctx.getWebSockets() reflects the disconnect automatically.
  }

  private async appendEvent(event: WireEvent): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>('seq')) ?? 0) + 1
    await this.ctx.storage.put('seq', seq)

    const subscribers = this.ctx.getWebSockets()
    const frame = JSON.stringify(notify('events.append', event))
    for (const ws of subscribers) ws.send(frame)

    // TODO: enqueue to EVENT_INGEST for durable D1 persistence; the queue
    // consumer batches into run_events.
  }

  private async snapshot(): Promise<RunMeta | null> {
    return (await this.ctx.storage.get<RunMeta>('meta')) ?? null
  }
}
