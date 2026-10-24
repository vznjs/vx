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

/**
 * A send the relay would not take, said by `warn` (2026-10-23: no fault is
 * silent). One to a participant the relay no longer knows (404) is not:
 * its loss reaches the other side as a notice of its own.
 */
export function unsent(
  warn: (message: string) => void,
  what: string,
  to: string,
): (err: unknown) => void {
  return (err) => {
    if (err instanceof RelayError && err.status === 404) return
    warn(
      `dte: sending ${what} to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * A dropped socket's first redial waits up to this, doubling per failure
 * (full jitter) to half a heartbeat: the relay loses a participant three
 * heartbeats without one.
 */
const FIRST_REDIAL_MS = 250
/** A frame of several sends stays under this, half the relay's 1 MiB body limit. */
const FRAME_BYTES = 512 * 1024
/** How long `leave` waits on its socket's close handshake. */
const CLOSE_WAIT_MS = 2_000
const UNANSWERED = 'the relay answered no frame'
/** The close code of a socket whose participant the relay lost or let go (PROTOCOL.md § Sockets). */
const GONE = 4404
/** This side's close of a socket that carried a frame no relay sends (RFC 6455 protocol error). */
const NOT_PROTOCOL = 1002
/**
 * No answer from the relay this long, every try counted, and it is gone
 * (owner, 2026-10-23: "no reply for 10s no matter of attempts its over").
 */
const REPLY_MS = 10_000
/**
 * How many times a request or a socket is tried again, after a fault (a
 * 5xx, a dropped connection) or a rate limit, before the participant gives
 * up: the run is live, or it isn't (owner, 2026-10-23: "3 retries nothing
 * more").
 */
const RETRIES = 3
/** The least either wait is: a loaded machine's loopback, under a test's short heartbeat. */
const MIN_WAIT_MS = 1_000
/**
 * How long a request or a dial waits on its answer: two heartbeats, a
 * relay's longest poll being one, at most `REPLY_MS`.
 */
const replyMs = (heartbeatMs: number): number =>
  Math.min(Math.max(2 * heartbeatMs, MIN_WAIT_MS), REPLY_MS)
/**
 * How long a frame waits on its answer: a heartbeat, so a quiet relay asked
 * after one is dead after two, `REPLY_MS` on the default, and this side
 * dials again before the relay, losing it after two silent, does.
 */
const answerMs = (heartbeatMs: number): number =>
  Math.min(Math.max(heartbeatMs, MIN_WAIT_MS), REPLY_MS)

/** Runs `f` again, at most `RETRIES` times, after a rate-limit answer or (`faults`) a fault. */
async function paced<T>(f: () => Promise<T>, signal?: AbortSignal, faults = true): Promise<T> {
  const by = performance.now() + REPLY_MS
  for (let tries = 0; ; tries++) {
    try {
      return await f()
    } catch (err) {
      // A request the relay held past its deadline already took the whole wait.
      const fault =
        err instanceof RelayError
          ? err.retryAfterMs !== undefined || (faults && err.status >= 500)
          : faults && (err as Error).name !== 'TimeoutError'
      const wait =
        err instanceof RelayError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : Math.random() * FIRST_REDIAL_MS * 2 ** tries
      if (!fault || tries >= RETRIES || signal?.aborted === true) throw err
      if (performance.now() + wait >= by) throw err
      await Bun.sleep(wait)
    }
  }
}

export interface Participant {
  readonly id: string
  readonly heartbeatMs: number
  send(to: string, body: unknown): Promise<void>
  /** Held up to one heartbeat, which also keeps this participant alive. */
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  /** The orchestrator takes a worker it did not admit off the run. */
  remove(worker: string): Promise<void>
  leave(): Promise<void>
}

export async function join(
  relay: string,
  run: string,
  role: 'orchestrator' | 'worker',
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
    paced(() => once(verb, body, query, signal), signal)
  // A relay that holds a request past its longest poll is stuck: Bun's
  // own limit let one poll wait five minutes before the run failed (CI,
  // 2026-10-22). Two heartbeats, once `join` says what one is, 10 s at most.
  let deadlineMs = REPLY_MS
  // The join, socket and request alike, has `REPLY_MS` in all: its socket
  // and then its request each took 10 s, and PR #4225's run failed after
  // 21 s on a bare "The operation timed out" (CI, 2026-10-24).
  let joinBy = performance.now() + REPLY_MS
  const once = async (verb: string, body?: unknown, query = '', signal?: AbortSignal) => {
    const method = body === undefined ? 'GET' : 'POST'
    const text = body === undefined ? '' : JSON.stringify(body)
    const limit = AbortSignal.timeout(Math.max(1, Math.min(deadlineMs, joinBy - performance.now())))
    const res = await fetch(base + verb + query, {
      method,
      headers: await headers(method, base + verb + query, text),
      ...(body === undefined ? {} : { body: text }),
      signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
    })
    if (res.status === 204) return null
    // A host's own error page (a proxy's, an empty one) is no relay answer.
    // quiet: the status names the refusal; a host's page is no relay answer
    const json = ((await res.json().catch(() => null)) ?? {}) as {
      error?: string
      retryAfterMs?: number
    }
    if (!res.ok) {
      // Refused at the door is no fault to wait out: say so, and stop.
      const message =
        verb === 'join' && (res.status === 401 || res.status === 403)
          ? `cannot connect to the relay ${new URL(base).origin}: ${json.error ?? res.status}`
          : `relay ${verb}: ${res.status} ${json.error ?? ''}`
      throw new RelayError(res.status, message, json.retryAfterMs)
    }
    return json as Record<string, unknown>
  }
  const asked = { role, info, ...(prover && { key: prover.key }) }
  const enter = async () => (await call('join', asked))!
  let id = ''
  let heartbeatMs = 0
  const dial = async () =>
    connect(base, `id=${id}`, await headers('GET', `${base}socket?id=${id}`, ''), heartbeatMs)
  /** What the sockets brought and nobody took yet, kept across redials. */
  const inbox: RelayMessage[] = []
  // One request a participant, which a host may bill: the socket joins as
  // it opens. One that does not (an older relay, a refusal only `join`
  // says the reason for) joins by request.
  const query = `join=${encodeURIComponent(JSON.stringify(asked))}`
  let socket: (Socket & { joined?: Joined }) | undefined
  try {
    socket = await connect(
      base,
      query,
      await headers('GET', `${base}socket?${query}`, ''),
      // quiet: a socket join that fails joins by request, whose refusal throws
    ).catch(() => undefined)
    if (socket?.joined !== undefined) ({ id, heartbeatMs } = socket.joined)
    else {
      const joined = await enter()
      id = joined['id'] as string
      heartbeatMs = joined['heartbeatMs'] as number
      if (joined['socket'] !== true) {
        throw new RelayError(
          501,
          'relay join: the relay offers no socket, which vx-dte needs (PROTOCOL.md § Sockets)',
        )
      }
      socket = await dial()
      // The relay made a run twice when two joins came at once and forgot the
      // first's participants, whose first socket never opened: two of twelve
      // workers on CI (2026-10-23). Joined again, it lands in the run that stayed.
      if (socket === undefined) {
        id = (await enter())['id'] as string
        socket = await dial()
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'TimeoutError') throw err
    throw new RelayError(
      504,
      `cannot connect to the relay ${new URL(base).origin}: no answer in ${REPLY_MS / 1000} s`,
    )
  }
  joinBy = Infinity
  deadlineMs = replyMs(heartbeatMs)
  let failures = 0
  /** When the socket was last open: dials past `REPLY_MS` from it give up. */
  let lostAt: number | undefined
  let redial: ReturnType<typeof setTimeout> | undefined
  /** A redial in flight, which `leave` waits out: its socket closes before the process exits. */
  let dialing: Promise<void> | undefined
  let left = false
  /** Why no socket is dialed again: the relay closed the run or forgot this participant. */
  let ended: RelayError | undefined
  /** Woken when a socket opens, brings messages or ends. */
  const waiters = new Set<() => void>()
  const nudge = (): void => {
    for (const w of [...waiters]) w()
  }
  const end = (err: RelayError): void => {
    ended ??= err
    clearTimeout(redial)
    redial = undefined
    nudge()
  }
  /** The last socket that closed: its close handshake may not have ended. */
  let dropped: Socket | undefined
  const adopt = (s: Socket): void => {
    socket = s
    s.onMessages = (messages) => {
      inbox.push(...messages)
      if (
        messages.some(
          (m) => m.from === 'relay' && (m.body as { type?: unknown })?.type === 'closed',
        )
      )
        end(new RelayError(410, 'relay: the run is closed'))
      nudge()
    }
    s.onClose = (code, why) => {
      // The relay closes the socket of a participant it lost or let go.
      if (code === GONE) end(new RelayError(404, 'relay: unknown id'))
      if (code === NOT_PROTOCOL) end(new RelayError(502, `relay: ${why}`))
      if (socket === s) socket = undefined
      dropped = s
      again()
      nudge()
    }
    inbox.push(...s.inbox.splice(0))
    nudge()
  }
  /** A socket that failed or dropped is dialed again after a jittered backoff. */
  const again = (): void => {
    if (left || ended !== undefined || redial !== undefined || socket?.open === true) return
    lostAt ??= performance.now()
    const ms = Math.random() * Math.min(heartbeatMs / 2, FIRST_REDIAL_MS * 2 ** failures)
    redial = setTimeout(() => {
      dialing = dial()
        // quiet: a failed redial dials again; past REPLY_MS the wait throws
        .catch(() => undefined)
        .then(async (s) => {
          redial = undefined
          dialing = undefined
          if (left || ended !== undefined) await s?.close()
          else took(s)
        })
    }, ms)
    redial.unref()
  }
  /** A dial's socket: one the relay closed at once is a failed dial, or the end. */
  const took = (s: Socket | undefined): void => {
    if (s?.open === true) {
      failures = 0
      lostAt = undefined
      adopt(s)
    } else if (s?.code === GONE) end(new RelayError(404, 'relay: unknown id'))
    else if (++failures > RETRIES) end(new RelayError(404, `relay: no socket in ${RETRIES} dials`))
    else if (performance.now() - lostAt! >= REPLY_MS)
      end(new RelayError(404, `relay: no socket in ${REPLY_MS / 1000} s`))
    else again()
  }
  const first = socket
  socket = undefined
  took(first)
  /** The open socket, waiting out a redial: `RETRIES` failed dials and the participant is gone. */
  const live = async (signal?: AbortSignal): Promise<Socket> => {
    for (;;) {
      if (ended !== undefined) throw ended
      const s = socket
      if (s?.open === true) return s
      again()
      if (signal?.aborted === true) throw signal.reason as Error
      await idle(heartbeatMs, signal)
    }
  }
  /** Until `nudge`, `ms` or `signal`, whichever comes first. */
  const idle = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done)
      waiters.add(done)
    })
  /** Down the open socket; one that closes under it is redialed and asked again. */
  const over = async (down: (s: Socket) => Promise<void>): Promise<void> => {
    for (;;) {
      const s = await live()
      try {
        await paced(() => down(s), undefined, false)
        return
      } catch (err) {
        // Closed under it: sent again on the next (a resent seal is a
        // replay its receiver drops).
        if (err instanceof RelayError) throw err
      }
    }
  }
  return {
    id,
    heartbeatMs,
    async send(to, body) {
      await over((s) => s.send(to, body))
    },
    async poll(signal) {
      if (inbox.length === 0 && signal?.aborted !== true) {
        const s = await live(signal)
        // It may have closed, or brought something, since `live` returned it.
        if (s.open && inbox.length === 0) await idle(heartbeatMs, signal)
      }
      if (inbox.length > 0) return inbox.splice(0)
      if (ended !== undefined) throw ended
      return []
    },
    async remove(worker) {
      await over((s) => s.request({ remove: worker }))
    },
    async leave() {
      left = true
      clearTimeout(redial)
      const s = socket
      // The relay drops it and closes the socket, which is its answer. With
      // no socket, the relay loses this participant as one gone silent.
      // quiet: leaving: the socket's close is the answer either way
      if (s?.open === true) await s.request({ leave: true }).catch(() => undefined)
      // One the relay's close frame dropped may still be in its handshake:
      // Bun 1.4.4 fires the close only after it.
      await Promise.all([(s ?? dropped)?.close(), dialing])
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
    // quiet: a token with no readable expiry is asked for again only when refused
  } catch {
    return Infinity
  }
}

interface Socket {
  readonly open: boolean
  /** What it brought before `onMessages` was set. */
  readonly inbox: RelayMessage[]
  /** The close code it closed with; 0 while open or with none. */
  readonly code: number
  onMessages?: (messages: RelayMessage[]) => void
  /** Its close, by the close code the relay gave (`GONE`), `NOT_PROTOCOL`, or none; `why` says it. */
  onClose?: (code: number, why: string) => void
  /** One frame, `{ leave: true }` or `{ remove }`; resolves on the relay's answer. */
  request(frame: Record<string, unknown>): Promise<void>
  /** A send; those asked for in one turn of the event loop go as one frame. */
  send(to: string, body: unknown): Promise<void>
  close(): Promise<void>
}

/** What a socket that joined says first (PROTOCOL.md `socket?join`). */
interface Joined {
  id: string
  heartbeatMs: number
}

/**
 * The participant's websocket (PROTOCOL.md `socket`): messages arrive the
 * moment they are sent, with no poll between. Undefined when it fails to
 * open; `join` dials again.
 */
async function connect(
  base: string,
  /** `id=<id>`, or `join=<body>` for one that joins as it opens. */
  query: string,
  headers: Record<string, string>,
  /** Unknown to one that joins, until its socket says. */
  heartbeatMs?: number,
): Promise<(Socket & { joined?: Joined }) | undefined> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}socket?${query}`, { headers })
  // An upgrade the relay holds is a dial that failed, as a request past two heartbeats.
  const wait = heartbeatMs === undefined ? REPLY_MS : replyMs(heartbeatMs)
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), wait)
    const settle = (ok: boolean) => () => {
      clearTimeout(timer)
      resolve(ok)
    }
    ws.onopen = settle(true)
    ws.onerror = settle(false)
    ws.onclose = settle(false)
  })
  if (!opened) {
    ws.close()
    return undefined
  }
  let open = true
  const inbox: RelayMessage[] = []
  let code = 0
  let n = 0
  let hb = heartbeatMs ?? REPLY_MS
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
    setTimeout(() => {
      if (!pending.has(k)) return
      closed(UNANSWERED)
      ws.close()
    }, answerMs(hb)).unref()
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
    framed = true
    ws.send(JSON.stringify({ n: k, sends: batch.map(({ to, body }) => ({ to, body })) }))
  }
  const request = (frame: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      const k = ++n
      answer(k, {
        settle: (a) => (a.status === undefined ? resolve() : reject(refused(a))),
        reject,
      })
      framed = true
      ws.send(JSON.stringify({ n: k, ...frame }))
    })
  // Alive while open; quiet, it is asked (owner, 2026-10-23: "check from
  // time to time if it sends sth, or if not ask to send. if it does not
  // reply for 10s its dead"). The ask is an empty frame the relay itself
  // answers: the host answers a ping without the relay behind it, and
  // 13baaf6's orchestrator heard nothing for 8 min. A frame unanswered past
  // `answerMs` closes the socket (`answer`). Each half heartbeat with no
  // frame sent pings, which the host answers free, so the relay, losing a
  // participant silent two heartbeats, hears this side four times a loss
  // window: one late timer is no loss.
  let framed = false
  let spoke = performance.now()
  let ping: ReturnType<typeof setInterval> | undefined
  const beat = (): void => {
    ping = setInterval(() => {
      if (framed) framed = false
      else if (performance.now() - spoke >= hb) frame([])
      else ws.send('ping')
    }, hb / 2)
    ping.unref()
  }
  if (heartbeatMs !== undefined) beat()
  let said: (j: Joined | undefined) => void = () => {}
  const joined = new Promise<Joined | undefined>((resolve) => {
    said = resolve
  })
  const closed = (why = 'socket closed', by = 0): void => {
    if (!open) return
    open = false
    code = by
    clearInterval(ping)
    for (const p of pending.values()) p.reject(new Error(why))
    pending.clear()
    said(undefined)
    me.onClose?.(by, why)
  }
  let shut: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    shut = resolve
  })
  ws.onclose = (e) => {
    closed('socket closed', e.code)
    shut()
  }
  ws.onerror = () => closed()
  ws.onmessage = (e) => {
    if (e.data === 'pong') return
    spoke = performance.now()
    let m: Answer & { messages?: RelayMessage[]; n?: number; joined?: Joined; close?: number }
    try {
      m = JSON.parse(String(e.data)) as typeof m
      if (typeof m !== 'object' || m === null) throw new Error()
    } catch {
      // Thrown here it left the process on a bare SyntaxError: a relay is anyone's to host.
      closed(`a frame that is not its protocol: ${String(e.data).slice(0, 200)}`, NOT_PROTOCOL)
      ws.close(NOT_PROTOCOL)
      return
    }
    // The relay says its close first: Bun 1.4.4 reports the close itself
    // only once the host ends TCP, which workerd never did (10 s late).
    if (m.close !== undefined) {
      closed('socket closed', typeof m.close === 'number' ? m.close : 0)
      ws.close()
      return
    }
    if (m.joined !== undefined) {
      hb = m.joined.heartbeatMs
      me.joined = m.joined
      beat()
      said(m.joined)
      return
    }
    if (m.messages !== undefined) {
      if (me.onMessages === undefined) inbox.push(...m.messages)
      else me.onMessages(m.messages)
      return
    }
    const p = pending.get(m.n!)
    pending.delete(m.n!)
    p?.settle(m)
  }
  const me: Socket & { joined?: Joined } = {
    get open() {
      return open
    },
    get code() {
      return code
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
    async close() {
      closed()
      ws.close(1000)
      // Its close handshake, so a process exiting next does not cut the
      // socket (the host logs that as a client that disconnected).
      await Promise.race([done, Bun.sleep(CLOSE_WAIT_MS)])
    },
  }
  if (heartbeatMs === undefined) {
    const timer = setTimeout(() => said(undefined), wait)
    const j = await joined
    clearTimeout(timer)
    if (j === undefined) {
      await me.close()
      return undefined
    }
  }
  return me
}
