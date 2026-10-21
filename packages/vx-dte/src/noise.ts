// The Noise Protocol Framework (noiseprotocol.org, revision 34), the two
// patterns a relay session uses, on WebCrypto: `NNpsk0` when the run has a
// key (VX_DTE_SECRET, a plan's or a per-run one), `NN` on GitHub keyless,
// where each side's OIDC token binds the handshake instead. X25519,
// AES-256-GCM, SHA-256. Held to the cacophony test vectors (tests/noise.test.ts).

const subtle = crypto.subtle
const HASHLEN = 32
/** A transport message's plaintext at most, so its ciphertext fits Noise's 65535 bytes. */
export const MAX_PLAINTEXT = 65535 - 16
/** WebCrypto takes bytes over an `ArrayBuffer` only. */
export type Bytes = Uint8Array<ArrayBuffer>
const EMPTY: Bytes = new Uint8Array(0)

export type Pattern = 'NN' | 'NNpsk0'

/** PKCS#8 for a raw X25519 private key: this prefix, then its 32 bytes. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

interface KeyPair {
  readonly pub: Bytes
  readonly priv: CryptoKey
}

async function generate(): Promise<KeyPair> {
  const k = (await subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as CryptoKeyPair
  return { pub: new Uint8Array(await subtle.exportKey('raw', k.publicKey)), priv: k.privateKey }
}

/** A key pair from its raw private key: the test vectors fix each side's ephemeral. */
export async function fixedKey(raw: Bytes): Promise<KeyPair> {
  const pk8 = concat(PKCS8_PREFIX, raw)
  const priv = await subtle.importKey('pkcs8', pk8, { name: 'X25519' }, true, ['deriveBits'])
  const { x } = (await subtle.exportKey('jwk', priv)) as { x: string }
  return { pub: new Uint8Array(Buffer.from(x, 'base64url')), priv }
}

async function dh(mine: KeyPair, theirs: Bytes): Promise<Bytes> {
  const pub = await subtle.importKey('raw', theirs, { name: 'X25519' }, false, [])
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, mine.priv, 256))
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function hash(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', data))
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', k, data))
}

/** Noise's HKDF: two or three outputs from the chaining key and the input. */
async function hkdf(ck: Bytes, ikm: Bytes, n: 2 | 3): Promise<Bytes[]> {
  const temp = await hmac(ck, ikm)
  const o1 = await hmac(temp, Uint8Array.of(1))
  const o2 = await hmac(temp, concat(o1, Uint8Array.of(2)))
  if (n === 2) return [o1, o2]
  return [o1, o2, await hmac(temp, concat(o2, Uint8Array.of(3)))]
}

/** AESGCM's nonce: 32 zero bits, then the counter, big-endian. */
function nonce(n: number): Bytes {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setBigUint64(4, BigInt(n))
  return iv
}

async function aes(key: Bytes, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [use])
}

/** One direction of a session's transport: its key, and the nonce a message names. */
export class CipherState {
  private enc: Promise<CryptoKey> | undefined
  private dec: Promise<CryptoKey> | undefined
  constructor(private readonly k: Bytes) {}

  async encrypt(n: number, ad: Bytes, plaintext: Bytes): Promise<Bytes> {
    this.enc ??= aes(this.k, 'encrypt')
    const c = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce(n), additionalData: ad },
      await this.enc,
      plaintext,
    )
    return new Uint8Array(c)
  }

  /** Throws when it does not open. */
  async decrypt(n: number, ad: Bytes, ciphertext: Bytes): Promise<Bytes> {
    this.dec ??= aes(this.k, 'decrypt')
    const p = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce(n), additionalData: ad },
      await this.dec,
      ciphertext,
    )
    return new Uint8Array(p)
  }
}

/**
 * A handshake of `NN` or `NNpsk0`, initiator or responder:
 *   NN:      -> e          <- e, ee
 *   NNpsk0:  -> psk, e     <- e, ee
 * Two messages; then `split()` gives what each side sends and receives with.
 */
export class Handshake {
  private ck: Bytes = EMPTY
  private h: Bytes = EMPTY
  private k: CipherState | undefined
  private n = 0
  private e: KeyPair | undefined
  private re: Bytes | undefined
  private step = 0

  private constructor(
    private readonly initiator: boolean,
    private readonly psk: Bytes | undefined,
    private readonly fixed: KeyPair | undefined,
  ) {}

  static async start(opts: {
    readonly pattern: Pattern
    readonly initiator: boolean
    readonly prologue: Bytes
    /** 32 bytes; `NNpsk0` only. */
    readonly psk?: Bytes
    /** Tests only: this side's ephemeral. */
    readonly ephemeral?: KeyPair
  }): Promise<Handshake> {
    if ((opts.pattern === 'NNpsk0') !== (opts.psk !== undefined))
      throw new Error('NNpsk0 takes a psk, NN none')
    if (opts.psk !== undefined && opts.psk.length !== 32) throw new Error('a psk is 32 bytes')
    const hs = new Handshake(opts.initiator, opts.psk, opts.ephemeral)
    const name = new TextEncoder().encode(`Noise_${opts.pattern}_25519_AESGCM_SHA256`)
    hs.h =
      name.length <= HASHLEN
        ? concat(name, new Uint8Array(HASHLEN - name.length))
        : await hash(name)
    hs.ck = hs.h
    await hs.mixHash(opts.prologue)
    return hs
  }

  /** The handshake hash: what both sides end with, and what an identity token binds. */
  get hash(): Bytes {
    return this.h
  }

  private async mixHash(data: Bytes): Promise<void> {
    this.h = await hash(concat(this.h, data))
  }

  private async mixKey(ikm: Bytes): Promise<void> {
    const [ck, k] = await hkdf(this.ck, ikm, 2)
    this.ck = ck!
    this.k = new CipherState(k!)
    this.n = 0
  }

  private async mixKeyAndHash(ikm: Bytes): Promise<void> {
    const [ck, th, k] = await hkdf(this.ck, ikm, 3)
    this.ck = ck!
    await this.mixHash(th!)
    this.k = new CipherState(k!)
    this.n = 0
  }

  private async encryptAndHash(p: Bytes): Promise<Bytes> {
    const c = this.k === undefined ? p : await this.k.encrypt(this.n++, this.h, p)
    await this.mixHash(c)
    return c
  }

  private async decryptAndHash(c: Bytes): Promise<Bytes> {
    const p = this.k === undefined ? c : await this.k.decrypt(this.n++, this.h, c)
    await this.mixHash(c)
    return p
  }

  /** `e`: a fresh ephemeral, hashed, and in a psk handshake mixed into the key. */
  private async writeE(): Promise<Bytes> {
    this.e = this.fixed ?? (await generate())
    await this.mixHash(this.e.pub)
    if (this.psk !== undefined) await this.mixKey(this.e.pub)
    return this.e.pub
  }

  private async readE(re: Bytes): Promise<void> {
    this.re = re
    await this.mixHash(re)
    if (this.psk !== undefined) await this.mixKey(re)
  }

  /** This side's next handshake message, carrying `payload`. */
  async write(payload: Bytes = EMPTY): Promise<Bytes> {
    if (this.initiator !== (this.step === 0)) throw new Error('not this side’s turn')
    const parts: Bytes[] = []
    if (this.step === 0) {
      if (this.psk !== undefined) await this.mixKeyAndHash(this.psk)
      parts.push(await this.writeE())
    } else {
      parts.push(await this.writeE())
      await this.mixKey(await dh(this.e!, this.re!))
    }
    parts.push(await this.encryptAndHash(payload))
    this.step++
    return concat(...parts)
  }

  /** The other side's handshake message: its payload. Throws when it does not open. */
  async read(message: Bytes): Promise<Bytes> {
    if (this.initiator === (this.step === 0)) throw new Error('not the other side’s turn')
    if (message.length < 32) throw new Error('a handshake message too short')
    if (this.step === 0) {
      if (this.psk !== undefined) await this.mixKeyAndHash(this.psk)
      await this.readE(message.subarray(0, 32))
    } else {
      await this.readE(message.subarray(0, 32))
      await this.mixKey(await dh(this.e!, this.re!))
    }
    const payload = await this.decryptAndHash(message.subarray(32))
    this.step++
    return payload
  }

  /** After both messages: what this side sends with, and what it receives with. */
  async split(): Promise<{ send: CipherState; receive: CipherState }> {
    if (this.step !== 2) throw new Error('the handshake is not done')
    const [k1, k2] = await hkdf(this.ck, EMPTY, 2)
    const c1 = new CipherState(k1!)
    const c2 = new CipherState(k2!)
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 }
  }
}
