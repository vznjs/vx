// End-to-end encryption over the relay (design dte-2026-10.md, "Relay
// encryption"): each worker and the orchestrator run a Noise handshake
// (`noise.ts`) through it. With the run's key, `Noise_NNpsk0`: the key is
// the psk, so only a side that holds it completes. On GitHub keyless,
// `Noise_NN`, each side's OIDC token binding what it said. Every body after
// that is a Noise transport message. Ephemeral keys only: a leaked run key
// opens no past run.

import { createHash } from 'node:crypto'
import { type Bytes, type CipherState, Handshake, MAX_PLAINTEXT } from './noise.js'
import { unsent as unsentBy, type Participant, type RelayMessage } from './wire.js'

/**
 * What admits a side: the run's key (Noise's psk), or each side's CI
 * identity, whose token binds the handshake.
 */
export interface Proof {
  /** The psk: `NNpsk0`. Absent: `NN`, with `sign` and `check`. */
  readonly psk?: () => Promise<Bytes>
  sign?(parts: readonly string[]): Promise<string>
  check?(proof: string, parts: readonly string[]): Promise<boolean>
  /** What a side whose key fails lacks. */
  readonly mismatch: string
}

/** The run's shared secret: its SHA-256 is the psk. */
export function secretProof(secret: string): Proof {
  let psk: Promise<Bytes> | undefined
  return {
    psk: () =>
      (psk ??= crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(secret))
        .then((b) => new Uint8Array(b))),
    mismatch: 'set the same VX_DTE_SECRET',
  }
}

const GITHUB = 'https://token.actions.githubusercontent.com'

/**
 * An OIDC token for `audience` from GitHub's token endpoint. A 5xx or a
 * dropped connection is tried again, three tries in 10 s at most: one 503
 * ended a worker before it joined (PR #4146, 2026-10-23).
 */
export async function oidcToken(url: string, bearer: string, audience: string): Promise<string> {
  const until = performance.now() + 10_000
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `bearer ${bearer}` },
      signal: AbortSignal.timeout(Math.max(1, until - performance.now())),
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    if (typeof res !== 'string' && res.ok) {
      // quiet: a body that is not JSON holds no token, said below
      const value = ((await res.json().catch(() => null)) as { value?: unknown } | null)?.value
      if (typeof value !== 'string' || value === '')
        throw new Error("GitHub's OIDC token: no token in its answer")
      return value
    }
    const why = typeof res === 'string' ? res : await refusedWith(res)
    const again = typeof res === 'string' || res.status >= 500 || res.status === 429
    const pause = 250 * 2 ** (attempt - 1)
    if (!again || attempt >= 3 || performance.now() + pause >= until)
      throw new Error(`GitHub's OIDC token: ${why}`)
    await Bun.sleep(pause)
  }
}

/** A refusal by its status and GitHub's own `message`, bounded: a 403 said why the token was refused. */
async function refusedWith(res: Response): Promise<string> {
  // quiet: a body that is not JSON leaves the status to name the refusal
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null
  const said =
    typeof body?.message === 'string' ? body.message.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return `HTTP ${res.status}${said === '' ? '' : `: ${said}`}`
}

/**
 * Keyless on GitHub Actions: a side signs by an OIDC token whose audience
 * is the digest of what it signs, and checks one as GitHub's and of this
 * repository (`GITHUB_REPOSITORY_ID`). No secret is stored anywhere.
 * `runs`, the orchestrator's: the workflow runs it dispatched, whose jobs
 * alone are its workers (a run's id is a dispatch input anyone who reads
 * the repository's Actions sees); `undefined` admits any job of the
 * repository, as workers that join on their own are.
 */
export function githubProof(
  fetchJson?: (url: string) => Promise<unknown>,
  runs?: () => ReadonlySet<string> | undefined,
): Proof {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  const repo = process.env['GITHUB_REPOSITORY_ID']
  if (!url || !bearer || !repo) {
    const missing = Object.entries({
      ACTIONS_ID_TOKEN_REQUEST_URL: url,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer,
      GITHUB_REPOSITORY_ID: repo,
    }).flatMap(([k, v]) => (v ? [] : [k]))
    throw new Error(`not a GitHub Actions job with id-token: write (${missing.join(', ')})`)
  }
  const aud = (parts: readonly string[]): string =>
    `vx-dte:${createHash('sha256').update(parts.join('\0')).digest('base64url')}`
  // GitHub's keys, read once for every check.
  const seen = new Map<string, Promise<unknown>>()
  const read =
    fetchJson ??
    (async (u: string): Promise<unknown> => {
      const res = await fetch(u, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`${u}: ${res.status}`)
      return res.json()
    })
  const once = (u: string): Promise<unknown> => {
    let p = seen.get(u)
    if (p === undefined) {
      p = read(u)
      // quiet: the caller awaits p and hears its error; this only forgets it
      p.catch(() => seen.delete(u))
      seen.set(u, p)
    }
    return p
  }
  return {
    async sign(parts) {
      return oidcToken(url, bearer, aud(parts))
    },
    async check(token, parts) {
      const { createVerifier } = await import('@vzn/vx-dte-server')
      // A read of GitHub's keys that failed is no check: refused as one, a
      // keys outage read "its key is not the run's" (2026-10-23).
      let unread: unknown
      const verify = createVerifier({
        allow: [{ issuer: GITHUB }],
        audience: aud(parts),
        runClaims: {
          [GITHUB]: runs === undefined ? ['repository_id'] : ['repository_id', 'run_id'],
        },
        fetchJson: (u) =>
          once(u).catch((err: unknown) => {
            unread = err
            throw err
          }),
      })
      return verify(token).then(
        (t) => {
          const mine = runs?.()
          return t.run[0] === repo && (mine === undefined || mine.has(t.run[1]!))
        },
        () => {
          if (unread !== undefined) throw unread
          return false
        },
      )
    },
    mismatch: 'run it in a job of this repository with id-token: write',
  }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Bytes => new Uint8Array(Buffer.from(s, 'base64'))
const text = new TextEncoder()

/** Both sides bind the run: a handshake of one run does not complete in another. */
const prologue = (run: string): Bytes => text.encode(`vx-dte\0${run}`)

async function handshake(proof: Proof, initiator: boolean, run: string): Promise<Handshake> {
  const psk = await proof.psk?.()
  return Handshake.start({
    pattern: psk === undefined ? 'NN' : 'NNpsk0',
    initiator,
    prologue: prologue(run),
    ...(psk === undefined ? {} : { psk }),
  })
}

const REPLAY = Symbol('replay')

/**
 * The size a body is padded to, so the relay learns its size class, not
 * its size: a power of two from 256 bytes, then whole transport messages.
 */
function padded(n: number): number {
  if (n >= MAX_PLAINTEXT) return Math.ceil(n / MAX_PLAINTEXT) * MAX_PLAINTEXT
  return Math.min(2 ** Math.ceil(Math.log2(Math.max(n, 256))), MAX_PLAINTEXT)
}

/**
 * One worker and the orchestrator after their handshake. Each body is
 * Noise transport messages of at most 64 KiB, each naming its nonce, as
 * Noise allows for a transport that may reorder (§11.4); a nonce seen
 * before is a replay.
 */
class Session {
  private sent = 0
  private readonly seen = new Set<number>()
  /** The last send handed to the wire, or still sealing: the next waits on it. */
  private turn: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly tx: CipherState,
    private readonly rx: CipherState,
  ) {}

  /**
   * `body` sealed and handed to `wire`, in the order sends were asked for:
   * sealing is async, and a big body sealed first reached the wire after a
   * small one sealed next (a worker's `end` before its `ran`, 2026-10-26).
   * The wire numbers a send as it is handed over, so only the handing waits.
   */
  async send(body: unknown, wire: (sealed: { seal: string[] }) => Promise<void>): Promise<void> {
    let sent: Promise<void> | undefined
    const mine = this.turn.then(async () => {
      sent = wire(await this.seal(body))
    })
    // quiet: `await mine` below hands the caller this error; the next turn
    // must not inherit it.
    this.turn = mine.catch(() => undefined)
    await mine
    await sent
  }

  private async seal(body: unknown): Promise<{ seal: string[] }> {
    const plain = squeeze(text.encode(JSON.stringify(body)))
    // Trailing spaces: JSON.parse reads past them, and `unsqueeze` stops before them.
    const bytes = new Uint8Array(padded(plain.length)).fill(0x20)
    bytes.set(plain)
    const out: string[] = []
    const ad = bodyAd(this.sent, Math.ceil(bytes.length / MAX_PLAINTEXT))
    for (let at = 0; at === 0 || at < bytes.length; at += MAX_PLAINTEXT) {
      const n = this.sent++
      const c = await this.tx.encrypt(n, ad, bytes.subarray(at, at + MAX_PLAINTEXT))
      out.push(`${n}.${b64(c)}`)
    }
    return { seal: out }
  }

  /** The body; `REPLAY` for one delivered before; undefined for one that does not open. */
  async open(body: unknown): Promise<unknown> {
    const s = (body as { seal?: unknown } | null)?.seal
    if (!Array.isArray(s) || s.length === 0) return undefined
    const parts: { n: number; c: string }[] = []
    for (const p of s) {
      if (typeof p !== 'string') return undefined
      const [n, c] = p.split('.')
      const seq = Number(n)
      if (!Number.isSafeInteger(seq) || seq < 0 || c === undefined) return undefined
      parts.push({ n: seq, c })
    }
    if (this.seen.has(parts[0]!.n)) return REPLAY
    // Each part is sealed to its body's first nonce and part count: unbound,
    // a relay spliced a fresh first part onto a delivered body's second.
    const ad = bodyAd(parts[0]!.n, parts.length)
    try {
      const plain: Uint8Array[] = []
      for (const p of parts) plain.push(await this.rx.decrypt(p.n, ad, unb64(p.c)))
      for (const p of parts) this.seen.add(p.n)
      return JSON.parse(unsqueeze(Buffer.concat(plain)).toString())
      // quiet: a body that does not open is the relay's tampering, which the caller says
    } catch {
      return undefined
    }
  }
}

/** Leads a compressed body: no JSON starts with it. */
const ZSTD = 0

/**
 * A body over the smallest size class, zstd-compressed before it is sealed:
 * once sealed it is random bytes no relay or socket compression shrinks.
 * The padding still hides its size within a class.
 */
function squeeze(json: Uint8Array): Uint8Array {
  if (json.length <= 256) return json
  const z = Bun.zstdCompressSync(json)
  if (z.length + 5 >= json.length) return json
  const out = new Uint8Array(z.length + 5)
  out[0] = ZSTD
  new DataView(out.buffer).setUint32(1, z.length)
  out.set(z, 5)
  return out
}

function unsqueeze(plain: Uint8Array): Uint8Array {
  if (plain[0] !== ZSTD) return plain
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(1)
  return Bun.zstdDecompressSync(plain.subarray(5, 5 + n))
}

/** What each part of one body is sealed to: its first nonce and how many parts. */
function bodyAd(first: number, parts: number): Uint8Array<ArrayBuffer> {
  return text.encode(`${first}.${parts}`)
}

/** A worker's poll raises it when a body from the orchestrator does not open: the relay changed or replayed it. */
export class SealError extends Error {}

/** A flat object's JSON with sorted keys. */
function canonical(info: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(info).sort(([a], [b]) => (a < b ? -1 : 1))),
  )
}

/**
 * The orchestrator's side, the responder. Each relay `joined` carries an
 * worker's first handshake message, its info the payload; one this side
 * completes is answered with the second and passed on with that info, one
 * it cannot is refused here and never seen.
 */
export function sealOrchestrator(
  me: Participant,
  run: string,
  proof: Proof,
  warn: (message: string) => void = (m) => void process.stderr.write(`[vx] ${m}\n`),
): Participant {
  const unsent = (what: string, to: string) => unsentBy(warn, what, to)
  const sessions = new Map<string, Session>()
  /** A worker's first message, read: its info, and this side's answer. */
  const admit = async (
    info: Record<string, unknown>,
  ): Promise<{ info: Record<string, unknown>; hello: object; session: Session } | undefined> => {
    const { noise, token } = info
    if (typeof noise !== 'string') return undefined
    if (proof.psk === undefined) {
      if (typeof token !== 'string' || !(await proof.check!(token, ['join', run, noise])))
        return undefined
    }
    const hs = await handshake(proof, false, run)
    let payload: Uint8Array
    try {
      payload = await hs.read(unb64(noise))
      // quiet: a handshake that fails is a key mismatch, which the caller says
    } catch {
      return undefined
    }
    const parsed = JSON.parse(Buffer.from(payload).toString()) as Record<string, unknown>
    const answer = b64(await hs.write())
    const { send, receive } = await hs.split()
    const hello =
      proof.psk === undefined
        ? { type: 'hello', noise: answer, token: await proof.sign!(['hello', run, b64(hs.hash)]) }
        : { type: 'hello', noise: answer }
    return { info: parsed, hello, session: new Session(send, receive) }
  }
  return {
    id: me.id,
    heartbeatMs: me.heartbeatMs,
    get online() {
      return me.online
    },
    resumed: (f) => me.resumed(f),
    async send(to, body) {
      const s = sessions.get(to)
      if (s === undefined) throw new Error(`no session with ${to}`)
      await s.send(body, (sealed) => me.send(to, sealed))
    },
    async poll(signal) {
      const out: RelayMessage[] = []
      for (const m of await me.poll(signal)) {
        if (m.from === 'relay') {
          const b = m.body as { type?: string; id?: string; info?: Record<string, unknown> | null }
          if (b.type === 'joined') {
            const id = b.id!
            // A check that could not run (GitHub's keys unreachable) is no
            // mismatch: it was refused as one, and the cause never said.
            const got = await admit(b.info ?? {}).catch(
              (err: unknown) =>
                `its token could not be checked: ${err instanceof Error ? err.message : String(err)}`,
            )
            if (got === undefined || typeof got === 'string') {
              const reason = got ?? `its key is not the run’s: ${proof.mismatch}`
              warn(`dte: refused a worker: ${reason}`)
              await me.send(id, { type: 'refused', reason }).catch(unsent('refused', id))
              await me.remove(id).catch(unsent('remove', id))
              continue
            }
            sessions.set(id, got.session)
            await me.send(id, got.hello).catch(unsent('hello', id))
            out.push({ from: 'relay', body: { ...b, info: got.info } })
            continue
          }
          if (b.type === 'lost') sessions.delete(b.id!)
          out.push(m)
          continue
        }
        // One from a worker already gone is dropped; one that does not open
        // loses its worker, whose tasks run again elsewhere.
        const s = sessions.get(m.from)
        if (s === undefined) continue
        const body = await s.open(m.body)
        if (body === REPLAY) continue
        if (body === undefined) {
          sessions.delete(m.from)
          out.push({ from: 'relay', body: { type: 'lost', id: m.from } })
          continue
        }
        out.push({ from: m.from, body })
      }
      return out
    },
    remove: (worker) => me.remove(worker),
    leave: () => me.leave(),
  }
}

/**
 * The worker's side, the initiator: `join` with its first handshake message
 * (`info` the payload, sealed under the psk), then wait for the
 * orchestrator's. Before it, only a plain `refused` is passed on.
 */
export async function sealWorker(
  joinAs: (info: Record<string, unknown>) => Promise<Participant>,
  run: string,
  proof: Proof,
  info: Record<string, unknown>,
): Promise<Participant> {
  const hs = await handshake(proof, true, run)
  const noise = b64(await hs.write(text.encode(canonical(info))))
  const me = await joinAs(
    proof.psk === undefined ? { noise, token: await proof.sign!(['join', run, noise]) } : { noise },
  )
  let session: Session | undefined
  const answer = async (b: { noise?: unknown; token?: unknown }): Promise<boolean> => {
    if (typeof b.noise !== 'string') return false
    try {
      await hs.read(unb64(b.noise))
      // quiet: a hello that does not open is refused by the throw below
    } catch {
      return false
    }
    if (
      proof.psk === undefined &&
      (typeof b.token !== 'string' || !(await proof.check!(b.token, ['hello', run, b64(hs.hash)])))
    )
      return false
    const { send, receive } = await hs.split()
    session = new Session(send, receive)
    return true
  }
  return {
    id: me.id,
    heartbeatMs: me.heartbeatMs,
    get online() {
      return me.online
    },
    resumed: (f) => me.resumed(f),
    async send(to, body) {
      if (session === undefined) throw new Error('no session with the orchestrator yet')
      await session.send(body, (sealed) => me.send(to, sealed))
    },
    async poll(signal) {
      const out: RelayMessage[] = []
      for (const m of await me.poll(signal)) {
        if (m.from === 'relay') {
          out.push(m)
          continue
        }
        if (session === undefined) {
          const b = m.body as { type?: string; noise?: unknown; token?: unknown; reason?: unknown }
          if (b.type === 'hello' && (await answer(b))) continue
          if (b.type === 'refused' && typeof b.reason === 'string') {
            out.push(m)
            continue
          }
          throw new SealError(`the orchestrator’s key is not the run’s: ${proof.mismatch}`)
        }
        const body = await session.open(m.body)
        if (body === REPLAY) continue
        if (body === undefined)
          throw new SealError(
            'a message from the orchestrator did not open: the relay changed or replayed it',
          )
        out.push({ from: m.from, body })
      }
      return out
    },
    remove: (worker) => me.remove(worker),
    leave: () => me.leave(),
  }
}

/** A secret for one run, for workers its adapter starts. */
export function runSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}
