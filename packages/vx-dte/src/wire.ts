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

/** A dropped socket's first redial waits up to this, doubling per failure (full jitter). */
const FIRST_REDIAL_MS = 250
const MAX_REDIAL_MS = 30_000
/** A frame of several sends stays under this, half the relay's 1 MiB body limit. */
const FRAME_BYTES = 512 * 1024
/** How long `leave` waits on its socket's close handshake. */
const CLOSE_WAIT_MS = 2_000
const UNANSWERED = 'the relay answered no frame'
/**
 * A socket that brought no message this many heartbeats is asked about
 * over HTTP: a relay whose push to it failed queues for HTTP polls and
 * leaves it open, its pings answered, so nothing arrives again (two CI
 * runs hung 20 min, 2026-10-23).
 */
const QUIET_BEATS = 3
/** How long `join` waits on the relay, before it says how long a heartbeat is. */
const JOIN_DEADLINE_MS = 30_000
/** How long `join` asks again through faults (a 500 while a host restarts the relay). */
const JOIN_FAULT_MS = 15_000
/** The least either wait is: a loaded machine's loopback, under a test's short heartbeat. */
const MIN_WAIT_MS = 1_000

/**
 * Runs `f` again after each rate-limit answer, as long as the relay asks to
 * wait, and after a fault of the relay's host or the
 * network (a 5xx, a dropped connection) until faults have lasted that long.
 */
async function paced<T>(f: () => Promise<T>, faultMs: number, signal?: AbortSignal): Promise<T> {
  let since: number | undefined
  let faults = 0
  for (;;) {
    try {
      return await f()
    } catch (err) {
      if (err instanceof RelayError && err.retryAfterMs !== undefined) {
        await Bun.sleep(err.retryAfterMs)
        continue
      }
      // A request the relay held past its deadline already took the whole wait.
      const fault =
        err instanceof RelayError ? err.status >= 500 : (err as Error).name !== 'TimeoutError'
      if (!fault || signal?.aborted === true) throw err
      since ??= performance.now()
      const left = since + faultMs - performance.now()
      if (left <= 0) throw err
      // Each wait at most half a heartbeat, so a short fault costs little.
      await Bun.sleep(Math.min(left, faultMs / 6, Math.random() * FIRST_REDIAL_MS * 2 ** faults++))
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
  // A join asked again that the relay took leaves a second participant,
  // lost in three heartbeats; an agent whose join failed is lost for good.
  let faultMs = JOIN_FAULT_MS
  const call = (verb: string, body?: unknown, query = '', signal?: AbortSignal) =>
    paced(() => once(verb, body, query, signal), faultMs, signal)
  // A relay that holds a request past its longest poll is stuck: Bun's
  // own limit let one poll wait five minutes before the run failed (CI,
  // 2026-10-22). Three heartbeats, once `join` says what one is.
  let deadlineMs = JOIN_DEADLINE_MS
  const once = async (verb: string, body?: unknown, query = '', signal?: AbortSignal) => {
    const method = body === undefined ? 'GET' : 'POST'
    const text = body === undefined ? '' : JSON.stringify(body)
    const limit = AbortSignal.timeout(deadlineMs)
    const res = await fetch(base + verb + query, {
      method,
      headers: await headers(method, base + verb + query, text),
      ...(body === undefined ? {} : { body: text }),
      signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
    })
    if (res.status === 204) return null
    // A host's own error page (a proxy's, an empty one) is no relay answer.
    const json = ((await res.json().catch(() => null)) ?? {}) as {
      error?: string
      retryAfterMs?: number
    }
    if (!res.ok) {
      const message = `relay ${verb}: ${res.status} ${json.error ?? ''}`
      throw new RelayError(res.status, message, json.retryAfterMs)
    }
    return json as Record<string, unknown>
  }
  const joined = (await call('join', { role, info, ...(prover && { key: prover.key }) }))!
  const id = joined['id'] as string
  const heartbeatMs = joined['heartbeatMs'] as number
  deadlineMs = Math.max(3 * heartbeatMs, MIN_WAIT_MS)
  // The relay loses a participant silent this long: past it, nothing is left to reach.
  faultMs = 3 * heartbeatMs
  const offered = joined['socket'] === true
  const dial = async () =>
    connect(base, id, await headers('GET', `${base}socket?id=${id}`, ''), heartbeatMs)
  let socket = offered ? await dial() : undefined
  let failures = 0
  /** When a quiet socket's relay was last asked over HTTP what it queued. */
  let askedAt = 0
  let redial: ReturnType<typeof setTimeout> | undefined
  /** A redial in flight, which `leave` waits out: its socket closes before the process exits. */
  let dialing: Promise<void> | undefined
  let left = false
  /** The relay closed the run or forgot this participant: no socket is dialed again. */
  let ended = false
  const end = (): void => {
    ended = true
    clearTimeout(redial)
    redial = undefined
  }
  const heard = (messages: RelayMessage[]): RelayMessage[] => {
    if (
      messages.some((m) => m.from === 'relay' && (m.body as { type?: unknown })?.type === 'closed')
    )
      end()
    return messages
  }
  /** A socket that failed or dropped is dialed again after a jittered backoff; HTTP carries meanwhile. */
  const again = (): void => {
    if (!offered || left || ended || redial !== undefined || socket?.open === true) return
    const ms = Math.random() * Math.min(MAX_REDIAL_MS, FIRST_REDIAL_MS * 2 ** failures)
    redial = setTimeout(() => {
      dialing = dial()
        .catch(() => undefined)
        .then(async (s) => {
          redial = undefined
          dialing = undefined
          if (left) await s?.close()
          else if (s === undefined) {
            failures++
            again()
          } else {
            failures = 0
            // What the dropped one received and nobody polled yet.
            if (socket !== undefined) s.inbox.unshift(...socket.inbox.splice(0))
            socket = s
          }
        })
    }, ms)
    redial.unref()
  }
  again()
  /** `down` the socket when it is open, else (or when it closes under it) `http`. */
  const over = async (
    down: (s: Socket) => Promise<void>,
    http: () => Promise<unknown>,
  ): Promise<void> => {
    again()
    const s = socket
    if (s?.open === true) {
      try {
        await paced(() => down(s), 0)
        return
      } catch (err) {
        if (err instanceof RelayError) throw err
        // Closed under it: HTTP says whether the relay took it (a resent
        // seal is a replay its receiver drops).
      }
    }
    await http()
  }
  const polled = async (wait: number, signal?: AbortSignal): Promise<RelayMessage[]> => {
    const r = await call('poll', undefined, `?id=${id}&wait=${wait}`, signal).catch(
      (err: unknown) => {
        if (err instanceof RelayError && (err.status === 404 || err.status === 410)) end()
        throw err
      },
    )
    return (r?.['messages'] ?? []) as RelayMessage[]
  }
  return {
    id,
    heartbeatMs,
    async send(to, body) {
      await over(
        (s) => s.send(to, body),
        () => call('send', { id, to, body }),
      )
    },
    async poll(signal) {
      again()
      if (socket?.inbox.length) return heard(socket.inbox.splice(0))
      const s = socket
      if (s?.open === true) {
        const messages = await s.poll(signal)
        if (messages.length > 0 || signal?.aborted === true) return heard(messages)
        if (s.open) {
          if (performance.now() - Math.max(s.pushedAt, askedAt) < QUIET_BEATS * heartbeatMs)
            return []
          askedAt = performance.now()
          const queued = await polled(0, signal)
          // Queued for HTTP: the relay pushes down this socket no more. A
          // new one is dialed; what this one still brings is kept.
          if (queued.length > 0) {
            socket = undefined
            void s.close()
            const late = s.inbox.splice(0)
            again()
            return heard([...late, ...queued])
          }
          return []
        }
        // Closed while it waited: HTTP says why.
      }
      return heard(await polled(heartbeatMs, signal))
    },
    async remove(agent) {
      await over(
        (s) => s.request({ remove: agent }),
        () => call('remove', { id, agent }),
      )
    },
    async leave() {
      left = true
      clearTimeout(redial)
      const s = socket
      // The relay drops it and closes the socket, which is its answer.
      const http = () => call('leave', { id }).catch(() => undefined)
      if (s?.open === true)
        await s.request({ leave: true }).catch(async (err: Error) => {
          if (err.message === UNANSWERED) await http()
        })
      else await http()
      await Promise.all([s?.close(), dialing])
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
  /** When the relay last pushed messages down it. */
  readonly pushedAt: number
  /** One frame, `{ leave: true }` or `{ remove }`; resolves on the relay's answer. */
  request(frame: Record<string, unknown>): Promise<void>
  /** A send; those asked for in one turn of the event loop go as one frame. */
  send(to: string, body: unknown): Promise<void>
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  close(): Promise<void>
}

/**
 * The participant's websocket (PROTOCOL.md `socket`), when the relay offers
 * one: messages arrive the moment they are sent, with no poll between. A
 * failure leaves the participant on HTTP polling, which reports the truth,
 * until `join`'s redial gets a socket back.
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
  let pushedAt = performance.now()
  let wake: (() => void) | undefined
  let n = 0
  type Answer = {
    status?: number
    error?: string
    retryAfterMs?: number
    results?: (Answer | null)[]
  }
  const pending = new Map<number, { settle(a: Answer): void; reject(err: Error): void }>()
  // A host can answer pings without the object behind it (Cloudflare's
  // auto-response), so a socket whose relay fails every frame still looks
  // alive: one that leaves a frame unanswered for two heartbeats is dead.
  const answer = (k: number, p: { settle(a: Answer): void; reject(err: Error): void }): void => {
    pending.set(k, p)
    setTimeout(
      () => {
        if (!pending.has(k)) return
        closed(UNANSWERED)
        ws.close()
      },
      Math.max(2 * heartbeatMs, MIN_WAIT_MS),
    ).unref()
  }
  const refused = (a: Answer): RelayError =>
    new RelayError(a.status!, `relay send: ${a.status} ${a.error ?? ''}`, a.retryAfterMs)
  /** Sends asked for in this turn of the event loop, which go as one frame. */
  let sends: { to: string; body: unknown; resolve(): void; reject(err: Error): void }[] = []
  const flush = (): void => {
    const all = sends
    sends = []
    // Frames under the relay's body limit, which it applies to a frame whole.
    let batch: typeof all = []
    let bytes = 0
    for (const one of all) {
      const size = JSON.stringify(one.body)?.length ?? 0
      if (batch.length > 0 && bytes + size > FRAME_BYTES) {
        frame(batch)
        batch = []
        bytes = 0
      }
      batch.push(one)
      bytes += size
    }
    frame(batch)
  }
  const frame = (batch: typeof sends): void => {
    const k = ++n
    answer(k, {
      settle(a) {
        batch.forEach((one, i) => {
          const r = a.status !== undefined ? a : (a.results?.[i] ?? null)
          if (r === null || r.status === undefined) one.resolve()
          else one.reject(refused(r))
        })
      },
      reject: (err) => {
        for (const one of batch) one.reject(err)
      },
    })
    ws.send(JSON.stringify({ n: k, sends: batch.map(({ to, body }) => ({ to, body })) }))
  }
  const request = (frame: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      const k = ++n
      answer(k, {
        settle: (a) => (a.status === undefined ? resolve() : reject(refused(a))),
        reject,
      })
      ws.send(JSON.stringify({ n: k, ...frame }))
    })
  // A socket a network stops carrying sends no close: one silent for a
  // heartbeat and a half is dead, before the relay's three-heartbeat sweep
  // drops this participant. Pinged each half heartbeat, so a live one is not.
  let heard = performance.now()
  const ping = setInterval(() => {
    if (performance.now() - heard > 1.5 * heartbeatMs) {
      closed()
      ws.close()
    } else ws.send('ping')
  }, heartbeatMs / 2)
  ping.unref()
  const closed = (why = 'socket closed'): void => {
    if (!open) return
    open = false
    clearInterval(ping)
    for (const p of pending.values()) p.reject(new Error(why))
    pending.clear()
    wake?.()
  }
  let shut: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    shut = resolve
  })
  ws.onclose = () => {
    closed()
    shut()
  }
  ws.onerror = () => closed()
  ws.onmessage = (e) => {
    heard = performance.now()
    if (e.data === 'pong') return
    const m = JSON.parse(String(e.data)) as Answer & { messages?: RelayMessage[]; n?: number }
    if (m.messages !== undefined) {
      pushedAt = performance.now()
      inbox.push(...m.messages)
      wake?.()
      return
    }
    const p = pending.get(m.n!)
    pending.delete(m.n!)
    p?.settle(m)
  }
  return {
    get open() {
      return open
    },
    get pushedAt() {
      return pushedAt
    },
    inbox,
    request,
    send(to, body) {
      if (!open) return Promise.reject(new Error('socket closed'))
      return new Promise((resolve, reject) => {
        if (sends.length === 0) queueMicrotask(flush)
        sends.push({ to, body, resolve, reject })
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
    async close() {
      closed()
      ws.close(1000)
      // Its close handshake, so a process exiting next does not cut the
      // socket (the host logs that as a client that disconnected).
      await Promise.race([done, Bun.sleep(CLOSE_WAIT_MS)])
    },
  }
}
