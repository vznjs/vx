// A participant of the relay protocol (@vzn/vx-dte-relay's PROTOCOL.md).

export interface RelayMessage {
  readonly from: string
  readonly body: unknown
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A `429` of the relay's rate limit: when to ask again. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** Runs `f` again after each rate-limit answer, as long as the relay asks to wait. */
async function paced<T>(f: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await f()
    } catch (err) {
      if (!(err instanceof RelayError) || err.retryAfterMs === undefined) throw err
      await Bun.sleep(err.retryAfterMs)
    }
  }
}

export interface Participant {
  readonly id: string
  readonly heartbeatMs: number
  send(to: string, body: unknown): Promise<void>
  /** Held up to one heartbeat, which also keeps this participant alive. */
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  /** The orchestrator takes an agent it did not admit off the run. */
  remove(agent: string): Promise<void>
  leave(): Promise<void>
}

export async function join(
  relay: string,
  run: string,
  role: 'orchestrator' | 'agent',
  info: unknown,
  /** A function is asked again for a token about to expire: GitHub's last 5 minutes. */
  token: string | undefined | (() => Promise<string | undefined>),
): Promise<Participant> {
  const base = `${relay.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(run)}/`
  const auth = bearer(token)
  // The orchestrator signs each request by a key the relay keeps from its join.
  const prover =
    role === 'orchestrator' ? await (await import('@vzn/vx-dte-relay')).createProver() : undefined
  const headers = async (method: string, url: string, body: string) => {
    const h = await auth()
    if (prover !== undefined) {
      const { pathname, search } = new URL(url)
      h['vx-proof'] = await prover.proof(method, pathname + search, body)
    }
    return h
  }
  const call = (verb: string, body?: unknown, query = '', signal?: AbortSignal) =>
    paced(() => once(verb, body, query, signal))
  const once = async (verb: string, body?: unknown, query = '', signal?: AbortSignal) => {
    const method = body === undefined ? 'GET' : 'POST'
    const text = body === undefined ? '' : JSON.stringify(body)
    const res = await fetch(base + verb + query, {
      method,
      headers: await headers(method, base + verb + query, text),
      ...(body === undefined ? {} : { body: text }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (res.status === 204) return null
    const json = (await res.json().catch(() => ({}))) as { error?: string; retryAfterMs?: number }
    if (!res.ok) {
      const message = `relay ${verb}: ${res.status} ${json.error ?? ''}`
      throw new RelayError(res.status, message, json.retryAfterMs)
    }
    return json as Record<string, unknown>
  }
  const joined = (await call('join', { role, info, ...(prover && { key: prover.key }) }))!
  const id = joined['id'] as string
  const heartbeatMs = joined['heartbeatMs'] as number
  const socket =
    joined['socket'] === true
      ? await connect(base, id, await headers('GET', `${base}socket?id=${id}`, ''), heartbeatMs)
      : undefined
  return {
    id,
    heartbeatMs,
    async send(to, body) {
      if (socket?.open === true) {
        try {
          return await paced(() => socket.send(to, body))
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
    async remove(agent) {
      await call('remove', { id, agent })
    },
    async leave() {
      await call('leave', { id }).catch(() => undefined)
      socket?.close()
    },
  }
}

/** A token more than a minute from its `exp` is used again. */
function bearer(
  token: string | undefined | (() => Promise<string | undefined>),
): () => Promise<Record<string, string>> {
  let held: { value: string | undefined; until: number } | undefined
  return async () => {
    if (typeof token !== 'function') held ??= { value: token, until: Infinity }
    else if (held === undefined || Date.now() >= held.until) {
      const value = await token()
      held = { value, until: expiry(value) - 60_000 }
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (held.value !== undefined) headers['authorization'] = `Bearer ${held.value}`
    return headers
  }
}

/** A JWT's `exp` in ms; a token that is not one never expires here. */
function expiry(token: string | undefined): number {
  try {
    const exp = (
      JSON.parse(atob(token!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
        exp?: unknown
      }
    ).exp
    return typeof exp === 'number' ? exp * 1000 : Infinity
  } catch {
    return Infinity
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
      retryAfterMs?: number
    }
    if (m.messages !== undefined) {
      inbox.push(...m.messages)
      wake?.()
      return
    }
    const p = pending.get(m.n!)
    pending.delete(m.n!)
    if (m.status === undefined) p?.resolve()
    else
      p?.reject(
        new RelayError(m.status, `relay send: ${m.status} ${m.error ?? ''}`, m.retryAfterMs),
      )
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
