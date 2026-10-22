// A participant of the relay protocol (@vzn/vx-dte-relay's PROTOCOL.md).

export interface RelayMessage {
  readonly from: string
  readonly body: unknown
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface Participant {
  readonly id: string
  readonly heartbeatMs: number
  send(to: string, body: unknown): Promise<void>
  /** Held up to one heartbeat, which also keeps this participant alive. */
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  leave(): Promise<void>
}

export async function join(
  relay: string,
  run: string,
  role: 'orchestrator' | 'agent',
  info: unknown,
  token: string | undefined,
): Promise<Participant> {
  const base = `${relay.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(run)}/`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  const call = async (verb: string, body?: unknown, query = '', signal?: AbortSignal) => {
    const res = await fetch(base + verb + query, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (res.status === 204) return null
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok)
      throw new RelayError(res.status, `relay ${verb}: ${res.status} ${json.error ?? ''}`)
    return json as Record<string, unknown>
  }
  const joined = (await call('join', { role, info }))!
  const id = joined['id'] as string
  const heartbeatMs = joined['heartbeatMs'] as number
  const socket =
    joined['socket'] === true ? await connect(base, id, headers, heartbeatMs) : undefined
  return {
    id,
    heartbeatMs,
    async send(to, body) {
      if (socket?.open === true) {
        try {
          return await socket.send(to, body)
        } catch (err) {
          if (err instanceof RelayError) throw err
          // Closed under it: HTTP says whether the relay took it (a resent
          // seal is a replay its receiver drops).
        }
      }
      await call('send', { id, to, body })
    },
    async poll(signal) {
      if (socket?.inbox.length) return socket.inbox.splice(0)
      if (socket?.open === true) {
        const messages = await socket.poll(signal)
        // Closed while it waited: HTTP says why.
        if (messages.length > 0 || socket.open || signal?.aborted === true) return messages
      }
      const r = await call('poll', undefined, `?id=${id}&wait=${heartbeatMs}`, signal)
      return (r?.['messages'] ?? []) as RelayMessage[]
    },
    async leave() {
      await call('leave', { id }).catch(() => undefined)
      socket?.close()
    },
  }
}

interface Socket {
  readonly open: boolean
  readonly inbox: RelayMessage[]
  send(to: string, body: unknown): Promise<void>
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  close(): void
}

/**
 * The participant's websocket (PROTOCOL.md `socket`), when the relay offers
 * one: messages arrive the moment they are sent, with no poll between. Any
 * failure leaves the participant on HTTP polling, which reports the truth.
 */
async function connect(
  base: string,
  id: string,
  headers: Record<string, string>,
  heartbeatMs: number,
): Promise<Socket | undefined> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}socket?id=${id}`, { headers })
  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
    ws.onclose = () => resolve(false)
  })
  if (!opened) return undefined
  let open = true
  const inbox: RelayMessage[] = []
  let wake: (() => void) | undefined
  let n = 0
  const pending = new Map<number, { resolve(): void; reject(err: Error): void }>()
  const ping = setInterval(() => ws.send('ping'), heartbeatMs)
  ping.unref()
  const closed = (): void => {
    open = false
    clearInterval(ping)
    for (const p of pending.values()) p.reject(new Error('socket closed'))
    pending.clear()
    wake?.()
  }
  ws.onclose = closed
  ws.onerror = closed
  ws.onmessage = (e) => {
    if (e.data === 'pong') return
    const m = JSON.parse(String(e.data)) as {
      messages?: RelayMessage[]
      n?: number
      status?: number
      error?: string
    }
    if (m.messages !== undefined) {
      inbox.push(...m.messages)
      wake?.()
      return
    }
    const p = pending.get(m.n!)
    pending.delete(m.n!)
    if (m.status === undefined) p?.resolve()
    else p?.reject(new RelayError(m.status, `relay send: ${m.status} ${m.error ?? ''}`))
  }
  return {
    get open() {
      return open
    },
    inbox,
    send(to, body) {
      return new Promise((resolve, reject) => {
        const k = ++n
        pending.set(k, { resolve, reject })
        ws.send(JSON.stringify({ n: k, to, body }))
      })
    },
    async poll(signal) {
      if (inbox.length === 0 && open && signal?.aborted !== true) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            wake = undefined
            resolve()
          }
          const timer = setTimeout(done, heartbeatMs)
          signal?.addEventListener('abort', done)
          wake = done
        })
      }
      return inbox.splice(0)
    },
    close() {
      open = false
      clearInterval(ping)
      ws.close()
    },
  }
}
