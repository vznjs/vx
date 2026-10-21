// End-to-end encryption over the relay (design dte-2026-10.md, "Relay
// encryption"): each participant holds an X25519 key for this run only,
// the run's secret authenticates each public key by HMAC, and every body
// after the handshake is AES-256-GCM under a key ECDH gives the pair. The
// secret never encrypts, so a leaked secret opens no past run.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import type { Participant, RelayMessage } from './wire.js'

/** Raw X25519 public keys are the last 32 bytes of their SPKI DER. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

interface Keys {
  readonly pub: string
  readonly priv: KeyObject
}

function keys(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { pub: der.subarray(SPKI_PREFIX.length).toString('base64'), priv: privateKey }
}

/** What signs this side's key and checks the other side's: the run's secret, or each side's CI identity. */
export interface Proof {
  sign(parts: readonly string[]): Promise<string>
  check(proof: string, parts: readonly string[]): Promise<boolean>
  /** What a side whose key fails the check lacks. */
  readonly mismatch: string
}

/** The run's shared secret, by HMAC-SHA256. */
export function secretProof(secret: string): Proof {
  const mac = (parts: readonly string[]): string =>
    createHmac('sha256', secret).update(parts.join('\0')).digest('base64')
  return {
    sign: async (parts) => mac(parts),
    check: async (proof, parts) => same(proof, mac(parts)),
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

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A flat object's JSON with sorted keys: what a join's MAC covers, however the relay re-encodes it. */
function canonical(info: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(info).sort(([a], [b]) => (a < b ? -1 : 1))),
  )
}

const REPLAY = Symbol('replay')

/** One agent and the orchestrator: what each seals for the other and opens from it. */
class Session {
  private readonly key: Buffer
  private sent = 0
  private readonly seen = new Set<number>()

  constructor(
    mine: Keys,
    theirs: string,
    run: string,
    orchestratorPub: string,
    agentPub: string,
    private readonly out: 'o' | 'a',
  ) {
    let peer: KeyObject
    try {
      peer = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(theirs, 'base64')]),
        format: 'der',
        type: 'spki',
      })
    } catch {
      throw new Error('not an X25519 key')
    }
    const shared = diffieHellman({ privateKey: mine.priv, publicKey: peer })
    this.key = Buffer.from(
      hkdfSync('sha256', shared, run, `vx-dte\0${orchestratorPub}\0${agentPub}`, 32),
    )
  }

  seal(body: unknown): { seal: string } {
    const n = this.sent++
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(`${this.out}\0${n}`))
    const data = Buffer.concat([c.update(JSON.stringify(body)), c.final()])
    return {
      seal: `${n}.${iv.toString('base64')}.${Buffer.concat([data, c.getAuthTag()]).toString('base64')}`,
    }
  }

  /** The body; `REPLAY` for one delivered before; undefined for one that does not open. */
  open(body: unknown): unknown {
    const s = (body as { seal?: unknown } | null)?.seal
    if (typeof s !== 'string') return undefined
    const [n, iv, data] = s.split('.')
    const seq = Number(n)
    if (!Number.isSafeInteger(seq) || iv === undefined || data === undefined) return undefined
    if (this.seen.has(seq)) return REPLAY
    try {
      const bytes = Buffer.from(data, 'base64')
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
      d.setAAD(Buffer.from(`${this.out === 'o' ? 'a' : 'o'}\0${seq}`))
      d.setAuthTag(bytes.subarray(bytes.length - 16))
      const text = Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()])
      this.seen.add(seq)
      return JSON.parse(text.toString())
    } catch {
      return undefined
    }
  }
}

/** An agent's poll raises it when a body from the orchestrator does not open: the relay changed or replayed it. */
export class SealError extends Error {}

/**
 * The orchestrator's side. Each relay `joined` whose info the run's
 * secret signed is answered with this side's key and passed on without
 * `pub` and `mac`; one it did not sign is refused here and never seen.
 */
export function sealOrchestrator(me: Participant, run: string, proof: Proof): Participant {
  const mine = keys()
  const sessions = new Map<string, Session>()
  return {
    id: me.id,
    heartbeatMs: me.heartbeatMs,
    async send(to, body) {
      const s = sessions.get(to)
      if (s === undefined) throw new Error(`no session with ${to}`)
      await me.send(to, s.seal(body))
    },
    async poll(signal) {
      const out: RelayMessage[] = []
      for (const m of await me.poll(signal)) {
        if (m.from === 'relay') {
          const b = m.body as { type?: string; id?: string; info?: Record<string, unknown> | null }
          if (b.type === 'joined') {
            const { pub, mac: sig, ...info } = b.info ?? {}
            const id = b.id!
            let s: Session | undefined
            if (
              typeof pub === 'string' &&
              typeof sig === 'string' &&
              (await proof.check(sig, ['join', run, pub, canonical(info)]))
            ) {
              try {
                s = new Session(mine, pub, run, mine.pub, pub, 'o')
              } catch {}
            }
            if (s === undefined) {
              await me
                .send(id, {
                  type: 'refused',
                  reason: `its key is not the run’s: ${proof.mismatch}`,
                })
                .catch(() => undefined)
              continue
            }
            sessions.set(id, s)
            await me
              .send(id, {
                type: 'hello',
                pub: mine.pub,
                mac: await proof.sign(['hello', run, mine.pub, pub as string]),
              })
              .catch(() => undefined)
            out.push({ from: 'relay', body: { ...b, info } })
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
        const body = s.open(m.body)
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
 * The agent's side: `join` with `info` signed, then wait for the
 * orchestrator's key. Before it, only a plain `refused` is passed on.
 */
export async function sealAgent(
  joinAs: (info: Record<string, unknown>) => Promise<Participant>,
  run: string,
  proof: Proof,
  info: Record<string, unknown>,
): Promise<Participant> {
  const mine = keys()
  const me = await joinAs({
    ...info,
    pub: mine.pub,
    mac: await proof.sign(['join', run, mine.pub, canonical(info)]),
  })
  let session: Session | undefined
  return {
    id: me.id,
    heartbeatMs: me.heartbeatMs,
    async send(to, body) {
      if (session === undefined) throw new Error('no session with the orchestrator yet')
      await me.send(to, session.seal(body))
    },
    async poll(signal) {
      const out: RelayMessage[] = []
      for (const m of await me.poll(signal)) {
        if (m.from === 'relay') {
          out.push(m)
          continue
        }
        if (session === undefined) {
          const b = m.body as { type?: string; pub?: unknown; mac?: unknown; reason?: unknown }
          if (
            b.type === 'hello' &&
            typeof b.pub === 'string' &&
            typeof b.mac === 'string' &&
            (await proof.check(b.mac, ['hello', run, b.pub, mine.pub]))
          ) {
            session = new Session(mine, b.pub, run, b.pub, mine.pub, 'a')
            continue
          }
          if (b.type === 'refused' && typeof b.reason === 'string') {
            out.push(m)
            continue
          }
          throw new SealError(`the orchestrator’s key is not the run’s: ${proof.mismatch}`)
        }
        const body = session.open(m.body)
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
  return randomBytes(32).toString('base64url')
}
