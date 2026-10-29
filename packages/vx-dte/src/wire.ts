// A participant of the relay protocol (@vzn/vx-dte-server's PROTOCOL.md).

export interface RelayMessage {
  readonly from: string
  readonly body: unknown
}

/**
 * `s` with each C0/C1 control and DEL written as `\xNN`: a server's words
 * reach the terminal, and an `ESC ]` or `\r` in them retitled it or
 * overwrote the line before (core's `printable`, L-31).
 */
export const printable = (s: string): string =>
  // oxlint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
/**
 * The orchestrator probes a worker quiet this many heartbeats: each probe
 * and its ack are two frames, so a peer heard from is never asked.
 */
const PROBE_BEATS = 1.5
/** A worker probes its orchestrator quiet this long: after the orchestrator would have. */
const WORKER_PROBE_BEATS = 1.6
/**
 * A peer quiet this many is lost: a live one, acking a probe at once, is
 * heard within a round trip of it. Checked each tenth, loss lands by two
 * (4 s on the default).
 */
const LOST_BEATS = 1.9
/**
 * A relay that forgot this participant (a restart: it stores nothing) is
 * joined again for this many heartbeats; the orchestrator joins as the
 * run's host again, a worker as itself (2026-10-25: "If they can't
 * rejoin for 2 heartbeats, it's over").
 */
const REJOIN_BEATS = 2
/** What a probe delivers: nothing. */
const PROBED = Symbol('probe')
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
 * (2026-10-23: "no reply for 10s no matter of attempts its over").
 */
const REPLY_MS = 10_000
/**
 * How many times a request or a socket is tried again, after a fault (a
 * 5xx, a dropped connection), before the participant gives
 * up: the run is live, or it isn't (2026-10-23: "3 retries nothing
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
 * after one is dead after two, 4 s on the default, and this side
 * dials again before the relay, losing it after two silent, does.
 */
const answerMs = (heartbeatMs: number): number =>
  Math.min(Math.max(heartbeatMs, MIN_WAIT_MS), REPLY_MS)

/**
 * A send as it travels: numbered per receiver, so a resend is dropped as
 * seen, and carrying the sender's ack of what it took from that receiver,
 * so most acks cost no message of their own.
 */
interface Numbered {
  readonly seq: number
  readonly body: unknown
  readonly acked?: number
}
/** The receiver took every send to it numbered up to `acked`. */
interface Acked {
  readonly acked: number
}
const isNumbered = (b: unknown): b is Numbered =>
  typeof b === 'object' &&
  b !== null &&
  typeof (b as Numbered).seq === 'number' &&
  'body' in b &&
  Object.keys(b).length === ('acked' in b ? 3 : 2)
/**
 * A peer quiet a heartbeat is asked: a numbered send with no body, which
 * its receiver acknowledges at once and delivers to no one.
 */
interface Probe {
  readonly seq: number
  readonly acked?: number
}
const isProbe = (b: unknown): b is Probe =>
  typeof b === 'object' &&
  b !== null &&
  typeof (b as Probe).seq === 'number' &&
  !('body' in b) &&
  Object.keys(b).length === ('acked' in b ? 2 : 1)
const isAcked = (b: unknown): b is Acked =>
  typeof b === 'object' &&
  b !== null &&
  typeof (b as Acked).acked === 'number' &&
  Object.keys(b).length === 1

/** Runs `f` again after a fault, at most `RETRIES` times and within `REPLY_MS`. */
async function paced<T>(f: () => Promise<T>): Promise<T> {
  const by = performance.now() + REPLY_MS
  for (let tries = 0; ; tries++) {
    try {
      return await f()
    } catch (err) {
      // A request the relay held past its deadline already took the whole wait.
      const fault =
        err instanceof RelayError ? err.status >= 500 : (err as Error).name !== 'TimeoutError'
      const wait = Math.random() * FIRST_REDIAL_MS * 2 ** tries
      if (!fault || tries >= RETRIES) throw err
      if (performance.now() + wait >= by) throw err
      await Bun.sleep(wait)
    }
  }
}

export interface Participant {
  readonly id: string
  readonly heartbeatMs: number
  /** Whether it has a socket: with none, nobody can be heard. */
  readonly online: boolean
  /**
   * `f` is told when this side is back on a socket after none (no peer
   * named), or a worker joined again (it named): what each holds was not
   * said meanwhile, and is not lost for that.
   */
  resumed(f: (peer?: string) => void): void
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
  /** `dte({ headers })`: on every dial, the redials included. */
  extra: Readonly<Record<string, string>> = {},
): Promise<Participant> {
  const base = `${relay.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(run)}/`
  const auth = bearer(token, extra)
  // The orchestrator signs each request by a key the relay keeps from its join.
  const prover =
    role === 'orchestrator' ? await (await import('@vzn/vx-dte-server')).createProver() : undefined
  const headers = async (method: string, url: string, body: string) => {
    const h = await auth()
    if (prover !== undefined) {
      const { pathname, search } = new URL(url)
      h[PROOF_HEADER] = await prover.proof(method, pathname + search, body)
    }
    return h
  }
  const asked = {
    role: role === 'orchestrator' ? 'host' : 'peer',
    info,
    ...(prover && { key: prover.key }),
  }
  let id = ''
  let heartbeatMs = 0
  /** The relay's id for this participant now: a rejoin gets a new one, `id` stays the first. */
  let current = ''
  /** Joining again until then: the relay forgot this participant. */
  let rejoinBy: number | undefined
  const dial = async () => {
    if (rejoinBy === undefined)
      return connect(
        base,
        `id=${current}`,
        await headers('GET', `${base}socket?id=${current}`, ''),
        heartbeatMs,
      )
    // A worker names the id it first had: the orchestrator still holds it
    // by that one, and nobody else knows it (PROTOCOL.md: a secret).
    const again = role === 'orchestrator' ? asked : { ...asked, info: { rejoin: id } }
    const q = `join=${encodeURIComponent(JSON.stringify(again))}`
    const s = await connect(base, q, await headers('GET', `${base}socket?${q}`, ''))
    if (s?.joined !== undefined) {
      current = s.joined.id
      joins.add(s)
    }
    return s
  }
  /**
   * Sockets that joined: one the relay closes 4404 let this participant go
   * (removed, refused), where one dialed by its id was forgotten, by a
   * restart, and joins again.
   */
  const joins = new WeakSet<Socket>()
  let onResumed: ((peer?: string) => void) | undefined
  /** The orchestrator's workers that joined again: their relay id now, by the id it holds them by. */
  const relayIds = new Map<string, string>()
  /** And back: the id it holds a worker by, by its relay id now. */
  const heldIds = new Map<string, string>()
  /** What the sockets brought and nobody took yet, kept across redials. */
  const inbox: RelayMessage[] = []
  /**
   * Each receiver's sends it has not acknowledged yet, and when each last
   * went: sent again after a heartbeat, or at once on a new socket, so a
   * send survives a socket or a relay that dropped it (NATS-style: the
   * relay holds nothing a participant cannot send again).
   */
  const outbox = new Map<
    string,
    { next: number; unacked: Map<number, { body: unknown; at: number }> }
  >()
  /** Each sender's sends taken in order, and those that came ahead of a gap. */
  const taken = new Map<string, { upTo: number; ahead: Map<number, unknown> }>()
  /**
   * Acks owed, by peer: each rides the next send to its peer; those with
   * none in half a heartbeat go together in one frame, before any peer
   * sends again, in place of a ping.
   */
  const owing = new Set<string>()
  let acking: ReturnType<typeof setTimeout> | undefined
  const flushAcks = (): void => {
    clearTimeout(acking)
    acking = undefined
    if (left || ended !== undefined) return
    for (const peer of owing) {
      const upTo = taken.get(peer)?.upTo
      if (upTo === undefined) continue
      // quiet: a lost ack only costs a resend, which is dropped as seen
      put(peer, { acked: upTo } satisfies Acked).catch(() => undefined)
    }
    owing.clear()
  }
  /** `now`: a probe's ack goes at once, so its asker hears it within the loss window. */
  const ack = (to: string, now = false): void => {
    owing.add(to)
    if (now) return flushAcks()
    if (acking !== undefined) return
    acking = setTimeout(flushAcks, heartbeatMs / 2)
    acking.unref()
  }
  /** The ack owed `to`, if any, for a send to it to carry. */
  const owed = (to: string): { acked?: number } =>
    owing.delete(to) ? { acked: taken.get(to)!.upTo } : {}
  /**
   * When each peer was last heard from: the orchestrator's workers from
   * their `joined`, a worker's orchestrator from its join. One quiet
   * `PROBE_BEATS` is probed; one quiet `LOST_BEATS` is lost
   * (2026-10-23: "if it does not reply for 10s its dead"), on a socket that
   * never closed: the relay loses one whose socket closed and says so.
   */
  const heard = new Map<string, number>()
  /** `quiet`: an ack, a probe or a resend, which waits on no answer: the relay says only a failure. */
  const put = (to: string, frame: object, quiet = true): Promise<void> =>
    over((s) => s.send(relayIds.get(to) ?? to, frame, quiet))
  const settle = (from: string, acked: number): void => {
    const o = outbox.get(from)
    if (o !== undefined) for (const seq of o.unacked.keys()) if (seq <= acked) o.unacked.delete(seq)
  }
  /** What a socket brought, in each sender's order, each send once; acks and losses settle the outbox. */
  const take = (messages: readonly RelayMessage[]): RelayMessage[] => {
    const out: RelayMessage[] = []
    for (const m of messages) {
      const body = m.body
      if (m.from === 'relay') {
        const notice = body as { type?: unknown; id?: unknown; info?: unknown }
        if (notice?.type === 'joined' && typeof notice.id === 'string') {
          const was = (notice.info as { rejoin?: unknown } | null | undefined)?.rejoin
          if (typeof was === 'string') {
            rejoined(notice.id, was)
            continue
          }
          heard.set(notice.id, performance.now())
        }
        if (notice?.type === 'lost' && typeof notice.id === 'string') {
          const held = heldIds.get(notice.id) ?? notice.id
          forget(held)
          out.push({ from: m.from, body: { ...notice, id: held } })
          continue
        }
        out.push(m)
        continue
      }
      const from = heldIds.get(m.from) ?? m.from
      if (heard.has(from)) heard.set(from, performance.now())
      if (isAcked(body)) settle(from, body.acked)
      else if (isProbe(body)) {
        if (body.acked !== undefined) settle(from, body.acked)
        const t = taken.get(from) ?? { upTo: 0, ahead: new Map() }
        taken.set(from, t)
        if (body.seq > t.upTo) t.ahead.set(body.seq, PROBED)
        while (t.ahead.has(t.upTo + 1)) {
          const next = t.ahead.get(++t.upTo)
          t.ahead.delete(t.upTo)
          if (next !== PROBED) out.push({ from, body: next })
        }
        ack(from, true)
      } else if (isNumbered(body)) {
        if (body.acked !== undefined) settle(from, body.acked)
        let t = taken.get(from)
        if (t === undefined) taken.set(from, (t = { upTo: 0, ahead: new Map() }))
        if (body.seq > t.upTo) t.ahead.set(body.seq, body.body)
        while (t.ahead.has(t.upTo + 1)) {
          const next = t.ahead.get(++t.upTo)
          t.ahead.delete(t.upTo)
          if (next !== PROBED) out.push({ from, body: next })
        }
        ack(from)
      } else out.push({ from, body })
    }
    return out
  }
  /**
   * A worker joined again, as `relayId`, naming `was`, the id this side
   * holds it by: the run goes on with it, and what it missed goes again.
   * One this side does not hold is let go.
   */
  const rejoined = (relayId: string, was: string): void => {
    if (role !== 'orchestrator' || !heard.has(was)) {
      // quiet: let go, its socket's 4404 ends it
      over((s) => s.request({ remove: relayId })).catch(() => undefined)
      return
    }
    const old = relayIds.get(was)
    if (old !== undefined) heldIds.delete(old)
    relayIds.set(was, relayId)
    heldIds.set(relayId, was)
    heard.set(was, performance.now())
    resend(0, was)
    onResumed?.(was)
  }
  const forget = (peer: string): void => {
    heard.delete(peer)
    outbox.delete(peer)
    taken.delete(peer)
    const now = relayIds.get(peer)
    relayIds.delete(peer)
    if (now !== undefined) heldIds.delete(now)
  }
  /**
   * Only a quiet peer is probed: the orchestrator a worker quiet
   * `PROBE_BEATS`, a worker its orchestrator quiet a tenth longer, so in a
   * quiet pair the orchestrator's probe comes first and the pair trades
   * one probe and its ack. Either loses a peer quiet `LOST_BEATS`.
   */
  const listen = (): void => {
    // With no socket nobody is heard: the redial or rejoin decides.
    if (socket?.open !== true) return
    resend(heartbeatMs)
    const now = performance.now()
    // With no peer, the relay is asked instead: a frame it answers.
    if (heard.size === 0 && socket?.open === true && now - socket.heardAt >= heartbeatMs)
      socket.ask()
    for (const [peer, at] of heard) {
      const quiet = now - at
      if (quiet >= LOST_BEATS * heartbeatMs) {
        forget(peer)
        if (peer === 'orchestrator') {
          end(new RelayError(410, 'relay: the orchestrator went silent'))
          return
        }
        inbox.push({ from: 'relay', body: { type: 'lost', id: peer } })
        nudge()
      } else if (
        quiet >= (role === 'orchestrator' ? PROBE_BEATS : WORKER_PROBE_BEATS) * heartbeatMs &&
        // a numbered send's ack may be deferred past the loss line; a probe's is not
        ![...(outbox.get(peer)?.unacked.values() ?? [])].some((u) => u.body === PROBED)
      ) {
        let o = outbox.get(peer)
        if (o === undefined) outbox.set(peer, (o = { next: 0, unacked: new Map() }))
        const seq = ++o.next
        o.unacked.set(seq, { body: PROBED, at: now })
        // quiet: unacknowledged, it goes again
        put(peer, { seq, ...owed(peer) } satisfies Probe).catch(() => undefined)
      }
    }
  }
  /** Sends again what waited `ms` unacknowledged, to `only` or to all; all of it, at 0. */
  const resend = (ms: number, only?: string): void => {
    const now = performance.now()
    for (const [to, o] of outbox) {
      if (only !== undefined && to !== only) continue
      for (const [seq, u] of o.unacked) {
        if (now - u.at < ms) continue
        u.at = now
        // quiet: unacknowledged, it goes again next heartbeat
        const again = u.body === PROBED ? { seq } : { seq, body: u.body }
        put(to, { ...again, ...owed(to) }).catch(() => undefined)
      }
    }
  }
  // The socket joins as it opens: one request a participant, which a host
  // may bill. A refusal closes it saying why (PROTOCOL.md § Sockets).
  const query = `join=${encodeURIComponent(JSON.stringify(asked))}`
  let socket: (Socket & { joined?: Joined }) | undefined
  try {
    socket = await paced(async () => {
      const s = await connect(base, query, await headers('GET', `${base}socket?${query}`, ''))
      // A fault: dialed again within `REPLY_MS`.
      if (s === undefined) throw new Error('no socket')
      return s
    })
  } catch (err) {
    if (err instanceof RelayError) throw err
    throw new RelayError(
      504,
      `cannot connect to the relay ${new URL(base).origin}: no answer in ${REPLY_MS / 1000} s`,
    )
  }
  ;({ id, heartbeatMs } = socket.joined!)
  current = id
  joins.add(socket)
  let failures = 0
  /** When the socket was last open: dials past `REPLY_MS` from it give up. */
  let lostAt: number | undefined
  let redial: ReturnType<typeof setTimeout> | undefined
  /** A redial in flight, which `leave` waits out: its socket closes before the process exits. */
  let dialing: Promise<void> | undefined
  let left = false
  /** Its `leave` said: the relay's 4404 is that answer, not a restart. */
  let leaving = false
  /** Why no socket is dialed again: the relay closed the run or forgot this participant. */
  let ended: RelayError | undefined
  /** Woken when a socket opens, brings messages or ends. */
  const waiters = new Set<() => void>()
  const nudge = (): void => {
    for (const w of [...waiters]) w()
  }
  const end = (err: RelayError): void => {
    ended ??= err
    clearInterval(listening)
    clearTimeout(redial)
    redial = undefined
    nudge()
  }
  /** The last socket that closed: its close handshake may not have ended. */
  let dropped: Socket | undefined
  let adopted = false
  const adopt = (s: Socket): void => {
    socket = s
    s.onMessages = (messages) => {
      inbox.push(...take(messages))
      if (
        messages.some(
          (m) => m.from === 'relay' && (m.body as { type?: unknown })?.type === 'closed',
        )
      )
        end(new RelayError(410, 'relay: the run is closed'))
      nudge()
    }
    s.onClose = (code, why) => {
      // The relay closes the socket of a participant it lost or let go, or
      // refused (4000 plus the status).
      if (code === GONE && (joins.has(s) || leaving)) end(new RelayError(404, 'relay: unknown id'))
      else if (code === GONE) rejoinBy ??= performance.now() + REJOIN_BEATS * heartbeatMs
      else if ((refusal(code) ?? 500) < 500) end(new RelayError(code - 4000, `relay: ${why}`))
      if (code === NOT_PROTOCOL) end(new RelayError(502, `relay: ${why}`))
      if (socket === s) socket = undefined
      dropped = s
      again()
      nudge()
    }
    inbox.push(...take(s.inbox.splice(0)))
    // A new socket: what the old one may have dropped goes again, and
    // nobody could be heard while there was none.
    if (adopted) {
      const now = performance.now()
      for (const peer of heard.keys()) heard.set(peer, now)
      resend(0)
      onResumed?.()
    }
    adopted = true
    nudge()
  }
  /** A socket that failed or dropped is dialed again after a jittered backoff. */
  const again = (): void => {
    if (left || ended !== undefined || redial !== undefined || socket?.open === true) return
    lostAt ??= performance.now()
    const ms = Math.random() * Math.min(heartbeatMs / 2, FIRST_REDIAL_MS * 2 ** failures)
    redial = setTimeout(() => {
      dialing = dial()
        .catch((err: unknown) => {
          // A join refused for good ends it; one before the orchestrator
          // is back (410), or a fault, is tried again.
          if (
            rejoinBy !== undefined &&
            err instanceof RelayError &&
            err.status !== 409 &&
            err.status !== 410 &&
            err.status < 500
          )
            end(err)
          // quiet: a failed redial dials again; past REPLY_MS the wait throws
          return undefined
        })
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
      rejoinBy = undefined
      adopt(s)
    } else if (rejoinBy !== undefined) {
      if (performance.now() < rejoinBy) again()
      else
        end(
          new RelayError(404, `relay: unknown id, not joined again in ${REJOIN_BEATS} heartbeats`),
        )
    } else if (s?.code === GONE) {
      // The relay forgot it: a restart, as it stores nothing.
      rejoinBy = performance.now() + REJOIN_BEATS * heartbeatMs
      again()
    } else if (++failures > RETRIES)
      end(new RelayError(404, `relay: no socket in ${RETRIES} dials`))
    else if (performance.now() - lostAt! >= REPLY_MS)
      end(new RelayError(404, `relay: no socket in ${REPLY_MS / 1000} s`))
    else again()
  }
  // Every tenth of a heartbeat, so a peer quiet `LOST_BEATS` is lost within
  // two heartbeats (4 s on the default) of its last word, and what went
  // unacknowledged a heartbeat goes again before its receiver loses this.
  const listening = setInterval(listen, heartbeatMs / 10)
  listening.unref()
  if (role === 'worker') heard.set('orchestrator', performance.now())
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
  const over = async (down: (s: Socket) => Promise<void>, signal?: AbortSignal): Promise<void> => {
    for (;;) {
      const s = await live(signal)
      try {
        await down(s)
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
    get online() {
      return socket?.open === true
    },
    resumed(f) {
      onResumed = f
    },
    async send(to, body) {
      let o = outbox.get(to)
      if (o === undefined) outbox.set(to, (o = { next: 0, unacked: new Map() }))
      const seq = ++o.next
      o.unacked.set(seq, { body, at: performance.now() })
      // With no socket, as while the relay restarts, it waits in the outbox
      // for the next: the caller goes on (2026-10-25: "they just
      // continue uninterrupted").
      const s = socket
      if (s?.open !== true && ended === undefined) {
        again()
        return
      }
      try {
        if (s?.open !== true) throw ended!
        await s.send(relayIds.get(to) ?? to, { seq, body, ...owed(to) } satisfies Numbered)
      } catch (err) {
        // Closed under it: it goes again on the next socket.
        if (!(err instanceof RelayError)) return
        // To a peer this side holds that the relay does not know now, as
        // while it joins again: it goes again when that one is back, and
        // its loss is said apart.
        if (err instanceof RelayError && err.status === 404 && ended === undefined && heard.has(to))
          return
        // Refused: the caller hears it. Its number still goes, delivering
        // nothing: dropped, its receiver waited on it and on every send after.
        o.unacked.set(seq, { body: PROBED, at: 0 })
        throw err
      }
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
      const now = relayIds.get(worker) ?? worker
      forget(worker)
      await over((s) => s.request({ remove: now }))
    },
    async leave() {
      leaving = true
      clearInterval(listening)
      clearTimeout(acking)
      // The final call (2026-10-25): the relay keeps one whose socket
      // dropped for its redial, so only `leave` ends it, and a host's
      // session, at once. A socket that drops under it is dialed again
      // for it. The relay drops it and closes the socket: that is its answer.
      if (ended === undefined) {
        const said = over(
          (s) => s.request({ leave: true }),
          AbortSignal.timeout(replyMs(heartbeatMs)),
        )
        // quiet: leaving: the socket's close is the answer either way
        await said.catch(() => undefined)
      }
      left = true
      // Ends what still waits on a socket (an ack, a probe): no redial
      // would ever bring one, and each waits a heartbeat at a time, for good.
      end(new RelayError(410, 'relay: this participant left'))
      const s = socket
      // One the relay's close frame dropped may still be in its handshake:
      // Bun 1.4.4 fires the close only after it.
      await Promise.all([(s ?? dropped)?.close(), dialing])
    },
  }
}

/** A token more than a minute from its `exp` is used again. */
function bearer(
  token: string | undefined | (() => Promise<string | undefined>),
  extra: Readonly<Record<string, string>>,
): () => Promise<Record<string, string>> {
  let held: { value: string | undefined; until: number } | undefined
  return async () => {
    if (typeof token !== 'function') held ??= { value: token, until: Infinity }
    else if (held === undefined || Date.now() >= held.until) {
      const value = await token()
      held = { value, until: expiry(value) - 60_000 }
    }
    const headers: Record<string, string> = { ...extra, 'content-type': 'application/json' }
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
  /**
   * A send; those asked for in one turn of the event loop go as one frame.
   * A `quiet` one resolves once written: its frame, if all quiet, goes
   * unnumbered, which the relay answers only when a send in it fails.
   */
  send(to: string, body: unknown, quiet?: boolean): Promise<void>
  /** When the relay last said anything down it. */
  readonly heardAt: number
  /** An empty numbered frame, which the relay itself answers. */
  ask(): void
  close(): Promise<void>
}

/** The relay protocol this client speaks (PROTOCOL.md § Versions). */
const PROTOCOL = 'switchboard.v1'
/** The proof header (PROTOCOL.md § The host's key). */
const PROOF_HEADER = 'relay-proof'

/**
 * A relay message in vx-dte's words: the run's orchestrator is the
 * session's host, and a worker the relay lost is `lost`.
 */
function inward(m: RelayMessage): RelayMessage {
  if (m.from === 'host') return { from: 'orchestrator', body: m.body }
  const body = m.body as { type?: unknown } | null
  return m.from === 'relay' && body?.type === 'left'
    ? { from: m.from, body: { ...body, type: 'lost' } }
    : m
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
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}socket?${query}`, {
    headers,
    protocols: [PROTOCOL],
    // Each body is zstd-compressed before it is sealed, and sealed bytes do
    // not compress: deflate would cost both ends CPU for base64's overhead.
    perMessageDeflate: false,
  } as unknown as string[])
  // An upgrade the relay holds is a dial that failed, as a request past two heartbeats.
  const wait = heartbeatMs === undefined ? REPLY_MS : replyMs(heartbeatMs)
  // Its handlers are set before it opens: a relay that refuses closes at
  // once, and Bun may report that close, or its frame, with the open.
  let opening: (ok: boolean) => void = () => {}
  const opened = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), wait)
    opening = (ok) => {
      clearTimeout(timer)
      resolve(ok)
    }
  })
  ws.onopen = () => opening(true)
  let open = true
  const inbox: RelayMessage[] = []
  let code = 0
  let reason = ''
  let n = 0
  let hb = heartbeatMs ?? REPLY_MS
  type Answer = {
    status?: number
    error?: string
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
    new RelayError(a.status!, `relay send: ${a.status} ${printable(a.error ?? '')}`)
  /** Sends asked for in this turn of the event loop, which go as one frame. */
  let sends: {
    to: string
    body: unknown
    quiet: boolean
    resolve(): void
    reject(err: Error): void
  }[] = []
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
  const frame = (batch: typeof sends, asked = false): void => {
    const out = batch.map(({ to, body }) => ({ to: to === 'orchestrator' ? 'host' : to, body }))
    if (!asked && batch.every((one) => one.quiet)) {
      ws.send(JSON.stringify({ sends: out }))
      for (const one of batch) one.resolve()
      return
    }
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
    ws.send(JSON.stringify({ n: k, sends: out }))
    for (const one of batch) if (one.quiet) one.resolve()
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
  // A frame unanswered past `answerMs` closes the socket (`answer`); `join`
  // decides when to ask.
  let spoke = performance.now()
  let said: (j: Joined | undefined) => void = () => {}
  const joined = new Promise<Joined | undefined>((resolve) => {
    said = resolve
  })
  const closed = (words = 'socket closed', by = 0): void => {
    if (!open) return
    const why = printable(words)
    open = false
    code = by
    reason = why
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
    // An error before it closes the socket with no code: the close's code
    // and reason still say why it was refused.
    if (!open && code === 0) {
      code = e.code
      if (e.reason !== '') reason = e.reason
    }
    closed(e.reason || 'socket closed', e.code)
    shut()
    opening(false)
  }
  ws.onerror = () => {
    closed()
    opening(false)
  }
  ws.onmessage = (e) => {
    opening(true)
    spoke = performance.now()
    let m: Answer & {
      messages?: RelayMessage[]
      n?: number | null
      joined?: Joined
      close?: number
    }
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
      closed(m.error ?? 'socket closed', typeof m.close === 'number' ? m.close : 0)
      ws.close()
      return
    }
    if (m.joined !== undefined) {
      hb = m.joined.heartbeatMs
      me.joined = m.joined
      said(m.joined)
      return
    }
    if (m.messages !== undefined) {
      m.messages = m.messages.map(inward)
      if (me.onMessages === undefined) inbox.push(...m.messages)
      else me.onMessages(m.messages)
      return
    }
    if (m.n === undefined || m.n === null) {
      // An unnumbered frame's failure: an ack or probe to one the relay no
      // longer knows (404) is not one, its loss reaching this side apart.
      const failed = [m, ...(m.results ?? [])].filter(
        (a): a is Answer => a?.status !== undefined && a.status !== 404,
      )
      for (const a of failed) process.stderr.write(`[vx] dte: ${refused(a).message}\n`)
      return
    }
    const p = pending.get(m.n)
    pending.delete(m.n)
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
    get heardAt() {
      return spoke
    },
    ask: () => frame([], true),
    send(to, body, quiet = false) {
      if (!open) return Promise.reject(new Error('socket closed'))
      return new Promise((resolve, reject) => {
        if (sends.length === 0) queueMicrotask(flush)
        sends.push({ to, body, quiet, resolve, reject })
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
  if (!(await opened)) {
    closed()
    ws.close()
    if (heartbeatMs !== undefined) return undefined
  }
  if (heartbeatMs === undefined) {
    const timer = setTimeout(() => said(undefined), wait)
    const j = await joined
    clearTimeout(timer)
    if (j === undefined) {
      await me.close()
      const status = refusal(code)
      if (status === undefined) return undefined
      // A GitLab job with no `id_tokens` entry was told only `401 no bearer
      // token`, not what gives it one (2026-10-26).
      const hint =
        status === 401 && headers['authorization'] === undefined
          ? `: this job has no token for the relay (on GitLab, an id_tokens entry VX_DTE_TOKEN with aud ${base.replace(/\/v1\/sessions\/.*$/, '')}; on GitHub Actions, permissions: id-token: write)`
          : ''
      const why = `${status} ${reason}${hint}`
      throw new RelayError(
        status,
        status === 401 || status === 403
          ? `cannot connect to the relay ${new URL(base).origin}: ${why}`
          : `relay join: ${why}`,
      )
    }
  }
  return me
}

/** The HTTP status a close code refuses with (4000 plus it), if it is one. */
const refusal = (code: number): number | undefined =>
  code >= 4400 && code < 4600 ? code - 4000 : undefined
