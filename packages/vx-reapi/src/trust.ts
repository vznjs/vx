// Signed remote artifacts (cache trust, step 1). A store's write credential
// was the only boundary: a shared bucket or one token let any writer answer
// main's key. With `trust.keys`, a remote artifact is taken only when a listed
// Ed25519 key signed exactly this storage key and these bytes; CI's main job
// signs with `VX_CACHE_SIGNING_KEY`. The local store is this machine's own
// and is never signed.
//
// The signature travels as a zstd skippable frame after the artifact, so a
// reader without the wrapper still decodes it:
//   magic 0x184D2A5E (LE) · length (LE) · `v1 <key id> <base64 signature>`
// over `vx-sig-v1\0<storage key>\0<sha256 of the artifact bytes>`. Binding the
// key keeps a valid artifact from being replayed under another one.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { type RemoteCacheLayer, UserError } from '@vzn/vx'

const BODY_SIZE = 3 + 16 + 1 + 88
const TRAILER_SIZE = 8 + BODY_SIZE
const SKIPPABLE = 0x184d2a5e

// PKCS#8 and SPKI wrappers around a raw 32-byte Ed25519 seed and public key.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const TRUST_KEY = /^ed25519:([A-Za-z0-9+/]{43}=)$/

/** `trust` as a remote plugin takes it. */
export interface CacheTrustOptions {
  /** Public keys (`'ed25519:<base64 of the raw 32 bytes>'`) a downloaded artifact must be signed by. */
  keys: readonly string[]
}

interface Signer {
  keyId: string
  privateKey: KeyObject
}

function rawOf(text: string, what: string): Buffer {
  const raw = Buffer.from(text, 'base64')
  if (raw.byteLength !== 32 || raw.toString('base64') !== text) {
    throw new UserError(`${what} must be 32 bytes, base64`)
  }
  return raw
}

function keyIdOf(publicRaw: Uint8Array): string {
  return createHash('sha256').update(publicRaw).digest('hex').slice(0, 16)
}

function trustedKeys(keys: unknown, where: string): Map<string, KeyObject> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new UserError(
      `${where}: \`trust.keys\` must list at least one 'ed25519:<base64 public key>'`,
    )
  }
  const out = new Map<string, KeyObject>()
  for (const entry of keys) {
    const m = typeof entry === 'string' ? TRUST_KEY.exec(entry) : null
    if (m === null) {
      throw new UserError(
        `${where}: \`trust.keys\` entries are 'ed25519:<base64 public key>' (got ${JSON.stringify(entry)?.slice(0, 60)})`,
      )
    }
    const raw = rawOf(m[1]!, `${where}: \`trust.keys\` ${entry}`)
    out.set(
      keyIdOf(raw),
      createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' }),
    )
  }
  return out
}

/** `VX_CACHE_SIGNING_KEY` (a base64 Ed25519 seed) → the signer, never echoing the value. */
function signerOf(seed: string): Signer {
  const raw = rawOf(seed.trim(), 'VX_CACHE_SIGNING_KEY')
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicRaw = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.byteLength)
  return { keyId: keyIdOf(publicRaw), privateKey }
}

function message(key: string, digestHex: string): Buffer {
  return Buffer.from(`vx-sig-v1\0${key}\0${digestHex}`)
}

function trailerOf(signer: Signer, key: string, digestHex: string): Uint8Array {
  const sig = sign(null, message(key, digestHex), signer.privateKey).toString('base64')
  const out = new Uint8Array(TRAILER_SIZE)
  const view = new DataView(out.buffer)
  view.setUint32(0, SKIPPABLE, true)
  view.setUint32(4, BODY_SIZE, true)
  out.set(Buffer.from(`v1 ${signer.keyId} ${sig}`), 8)
  return out
}

/** Why `trailer` does not prove `digestHex` under `key`, or null when a trusted key signed it. */
function refusal(
  keys: ReadonlyMap<string, KeyObject>,
  key: string,
  digestHex: string,
  trailer: Uint8Array,
): string | null {
  const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength)
  if (
    trailer.byteLength !== TRAILER_SIZE ||
    view.getUint32(0, true) !== SKIPPABLE ||
    view.getUint32(4, true) !== BODY_SIZE
  ) {
    return 'not signed'
  }
  const m = /^v1 ([0-9a-f]{16}) ([A-Za-z0-9+/]{86}==)$/.exec(
    Buffer.from(trailer.subarray(8)).toString('latin1'),
  )
  if (m === null) return 'not signed'
  const publicKey = keys.get(m[1]!)
  if (publicKey === undefined) return `signed by a key this workspace does not trust (${m[1]})`
  return verify(null, message(key, digestHex), publicKey, Buffer.from(m[2]!, 'base64'))
    ? null
    : 'its signature does not match its key and bytes'
}

/**
 * The artifact without its signature frame, checked as it streams: the last
 * `TRAILER_SIZE` bytes are held back, and the stream errors at its end,
 * before core commits anything, unless a trusted key signed the rest.
 */
function verified(
  source: ReadableStream<Uint8Array>,
  keys: ReadonlyMap<string, KeyObject>,
  key: string,
): ReadableStream<Uint8Array> {
  const sha = createHash('sha256')
  let held: Uint8Array = new Uint8Array(0)
  const emit = (bytes: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (bytes.byteLength === 0) return
    sha.update(bytes)
    controller.enqueue(bytes)
  }
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // A chunk that holds a whole trailer's worth releases everything held
        // before it, uncopied; only a short chunk is joined to what is held.
        if (chunk.byteLength >= TRAILER_SIZE) {
          emit(held, controller)
          emit(chunk.subarray(0, chunk.byteLength - TRAILER_SIZE), controller)
          held = chunk.slice(chunk.byteLength - TRAILER_SIZE)
          return
        }
        const all = new Uint8Array(held.byteLength + chunk.byteLength)
        all.set(held)
        all.set(chunk, held.byteLength)
        const cut = Math.max(0, all.byteLength - TRAILER_SIZE)
        emit(all.subarray(0, cut), controller)
        held = all.subarray(cut)
      },
      flush(controller) {
        const why = refusal(keys, key, sha.digest('hex'), held)
        if (why !== null) controller.error(new Error(`artifact ${key} refused: ${why}`))
      },
    }),
  )
}

async function digestOf(body: Blob): Promise<string> {
  const sha = createHash('sha256')
  for await (const chunk of body.stream()) sha.update(chunk)
  return sha.digest('hex')
}

/**
 * `remote` with signed artifacts: downloads must carry a signature by one of
 * `trust.keys`, and uploads are signed with `VX_CACHE_SIGNING_KEY`. A run
 * without that key uploads nothing, since every reader would refuse it.
 */
export function signedRemote(
  remote: RemoteCacheLayer,
  trust: CacheTrustOptions,
  opts: { where: string; warn: (m: string) => void; signingKey?: string | undefined },
): RemoteCacheLayer {
  const keys = trustedKeys((trust as { keys?: unknown } | null)?.keys, opts.where)
  const seed = opts.signingKey?.trim()
  const signer = seed === undefined || seed === '' ? undefined : signerOf(seed)
  let told = false
  const layer: RemoteCacheLayer = {
    has: (hash) => remote.has(hash),
    async get(hash) {
      const got = await remote.get(hash)
      if (got === null) return null
      const stream = got.body instanceof Blob ? got.body.stream() : got.body.body
      if (stream === null) throw new Error(`artifact ${hash} refused: not signed`)
      return { body: new Response(verified(stream, keys, hash)), durationMs: got.durationMs }
    },
    async put(hash, body, meta) {
      if (signer === undefined) {
        if (!told) {
          told = true
          opts.warn(
            `${opts.where}: trust.keys is set and VX_CACHE_SIGNING_KEY is not: nothing is uploaded`,
          )
        }
        return
      }
      const trailer = trailerOf(signer, hash, await digestOf(body))
      await remote.put(hash, new Blob([body, trailer]), meta)
    },
  }
  if (remote.endpoint !== undefined) Object.assign(layer, { endpoint: remote.endpoint })
  if (remote.hasMany !== undefined) layer.hasMany = (hashes) => remote.hasMany!(hashes)
  return layer
}
