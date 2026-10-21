// End-to-end encryption over the relay (design dte-2026-10.md, "Relay
// encryption"): each agent and the orchestrator run a Noise handshake
// (`noise.ts`) through it. With the run's key, `Noise_NNpsk0`: the key is
// the psk, so only a side that holds it completes. On GitHub keyless,
// `Noise_NN`, each side's OIDC token binding what it said. Every body after
// that is a Noise transport message. Ephemeral keys only: a leaked run key
// opens no past run.

import { createHash } from 'node:crypto'
import { type Bytes, type CipherState, Handshake, MAX_PLAINTEXT } from './noise.js'
import type { Participant, RelayMessage } from './wire.js'

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
 * Keyless on GitHub Actions: a side signs by an OIDC token whose audience
 * is the digest of what it signs, and checks one as GitHub's and of this
 * repository (`GITHUB_REPOSITORY_ID`). No secret is stored anywhere.
 */
export function githubProof(fetchJson?: (url: string) => Promise<unknown>): Proof {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  const repo = process.env['GITHUB_REPOSITORY_ID']
  if (!url || !bearer || !repo)
    throw new Error('not a GitHub Actions job with id-token: write (ACTIONS_ID_TOKEN_REQUEST_URL)')
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
      p.catch(() => seen.delete(u))
      seen.set(u, p)
    }
    return p
  }
  return {
    async sign(parts) {
      const res = await fetch(`${url}&audience=${encodeURIComponent(aud(parts))}`, {
        headers: { authorization: `bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`GitHub's OIDC token: ${res.status}`)
      return ((await res.json()) as { value: string }).value
    },
    async check(token, parts) {
      const { createVerifier } = await import('@vzn/vx-dte-relay')
      const verify = createVerifier({
        issuers: [GITHUB],
        audience: aud(parts),
        runClaims: { [GITHUB]: ['repository_id'] },
        fetchJson: once,
      })
      return verify(token).then(
        (t) => t.run[0] === repo,
        () => false,
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
 * One agent and the orchestrator after their handshake. Each body is
 * Noise transport messages of at most 64 KiB, each naming its nonce, as
 * Noise allows for a transport that may reorder (§11.4); a nonce seen
 * before is a replay.
 */
class Session {
  private sent = 0
  private readonly seen = new Set<number>()

  constructor(
    private readonly tx: CipherState,
    private readonly rx: CipherState,
  ) {}

  async seal(body: unknown): Promise<{ seal: string[] }> {
    const bytes = text.encode(JSON.stringify(body))
    const out: string[] = []
    for (let at = 0; at === 0 || at < bytes.length; at += MAX_PLAINTEXT) {
      const n = this.sent++
      const c = await this.tx.encrypt(n, new Uint8Array(0), bytes.subarray(at, at + MAX_PLAINTEXT))
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
    try {
      const plain: Uint8Array[] = []
      for (const p of parts) plain.push(await this.rx.decrypt(p.n, new Uint8Array(0), unb64(p.c)))
      for (const p of parts) this.seen.add(p.n)
      return JSON.parse(Buffer.concat(plain).toString())
    } catch {
      return undefined
    }
  }
}

/** An agent's poll raises it when a body from the orchestrator does not open: the relay changed or replayed it. */
export class SealError extends Error {}

/** A flat object's JSON with sorted keys. */
function canonical(info: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(info).sort(([a], [b]) => (a < b ? -1 : 1))),
  )
}

/**
 * The orchestrator's side, the responder. Each relay `joined` carries an
 * agent's first handshake message, its info the payload; one this side
 * completes is answered with the second and passed on with that info, one
 * it cannot is refused here and never seen.
 */
export function sealOrchestrator(me: Participant, run: string, proof: Proof): Participant {
  const sessions = new Map<string, Session>()
  /** An agent's first message, read: its info, and this side's answer. */
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
    async send(to, body) {
      const s = sessions.get(to)
      if (s === undefined) throw new Error(`no session with ${to}`)
      await me.send(to, await s.seal(body))
    },
    async poll(signal) {
      const out: RelayMessage[] = []
      for (const m of await me.poll(signal)) {
        if (m.from === 'relay') {
          const b = m.body as { type?: string; id?: string; info?: Record<string, unknown> | null }
          if (b.type === 'joined') {
            const id = b.id!
            const got = await admit(b.info ?? {}).catch(() => undefined)
            if (got === undefined) {
              await me
                .send(id, {
                  type: 'refused',
                  reason: `its key is not the run’s: ${proof.mismatch}`,
                })
                .catch(() => undefined)
              continue
            }
            sessions.set(id, got.session)
            await me.send(id, got.hello).catch(() => undefined)
            out.push({ from: 'relay', body: { ...b, info: got.info } })
            continue
          }
          if (b.type === 'lost') sessions.delete(b.id!)
          out.push(m)
          continue
        }
        // One from an agent already gone is dropped; one that does not open
        // loses its agent, whose tasks run again elsewhere.
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
    leave: () => me.leave(),
  }
}

/**
 * The agent's side, the initiator: `join` with its first handshake message
 * (`info` the payload, sealed under the psk), then wait for the
 * orchestrator's. Before it, only a plain `refused` is passed on.
 */
export async function sealAgent(
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
    async send(to, body) {
      if (session === undefined) throw new Error('no session with the orchestrator yet')
      await me.send(to, await session.seal(body))
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
    leave: () => me.leave(),
  }
}

/** A secret for one run, for agents its adapter starts. */
export function runSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}
