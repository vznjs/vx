// Signed artifacts (cache trust, step 1): a trusted writer signs each
// artifact it packs, and a workspace that lists trusted keys takes a remote
// artifact only when one of them signed it. A key in an artifact says what
// it claims to be, never who wrote it; the store's own write credential was
// the only boundary, and a shared bucket or one token has none.
//
// Ed25519 over `vx-sig-v1\0<cache key>\0<sha256 of the entries>`, the
// digest taken over the same bytes the CRC-32 sum walks. Binding the key
// keeps a valid artifact from being replayed under another key.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { UserError } from '../util/index.js'

/** The `.vx-sig` body: `v1 <key id> <base64 signature>`. */
export const SIG_SIZE = 3 + 16 + 1 + 88

/** What signs an artifact as it is packed. */
export interface ArtifactSigner {
  readonly keyId: string
  sign(message: Uint8Array): Uint8Array
}

/** A workspace's `cacheTrust`, resolved: the keys a remote artifact must be signed by, and this run's signer. */
export interface CacheTrust {
  readonly keys: ReadonlyMap<string, KeyObject>
  readonly signer: ArtifactSigner | undefined
}

// PKCS#8 and SPKI wrappers around a raw 32-byte Ed25519 seed and public key.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const TRUST_KEY = /^ed25519:([A-Za-z0-9+/]{43}=)$/

function rawOf(text: string, what: string): Buffer {
  const raw = Buffer.from(text, 'base64')
  if (raw.byteLength !== 32 || raw.toString('base64') !== text) {
    throw new UserError(`${what} must be 32 bytes, base64`)
  }
  return raw
}

/** The id a signature names its key by: the first 16 hex digits of the public key's SHA-256. */
function keyIdOf(publicRaw: Uint8Array): string {
  return createHash('sha256').update(publicRaw).digest('hex').slice(0, 16)
}

/** `cacheTrust.keys` entry → its id and key; the error names the entry. */
export function parseTrustKey(entry: string, where: string): [string, KeyObject] {
  const m = TRUST_KEY.exec(entry)
  if (m === null) {
    throw new UserError(
      `${where}: \`cacheTrust.keys\` entries are 'ed25519:<base64 public key>' (got ${JSON.stringify(entry.slice(0, 60))})`,
    )
  }
  const raw = rawOf(m[1]!, `${where}: \`cacheTrust.keys\` ${entry}`)
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
  return [keyIdOf(raw), key]
}

/** `VX_CACHE_SIGNING_KEY` (a base64 Ed25519 seed) → the signer, never echoing the value. */
export function signerOf(seed: string): ArtifactSigner {
  const raw = rawOf(seed.trim(), 'VX_CACHE_SIGNING_KEY')
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicRaw = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_PREFIX.byteLength)
  const keyId = keyIdOf(publicRaw)
  return { keyId, sign: (message) => sign(null, message, privateKey) }
}

/** The bytes a signature covers. */
export function signedMessage(cacheKey: string, digestHex: string): Uint8Array {
  return new TextEncoder().encode(`vx-sig-v1\0${cacheKey}\0${digestHex}`)
}

/** The `.vx-sig` body for a signer's signature over `message`. */
export function signatureEntry(signer: ArtifactSigner, message: Uint8Array): string {
  return `v1 ${signer.keyId} ${Buffer.from(signer.sign(message)).toString('base64')}`
}

/**
 * Why an artifact's signature does not hold under `keys`, or null when one
 * of them signed exactly this key and these entries.
 */
export function signatureRefusal(
  keys: ReadonlyMap<string, KeyObject>,
  cacheKey: string,
  digestHex: string | undefined,
  entry: string | undefined,
): string | null {
  if (entry === undefined || digestHex === undefined) return 'artifact is not signed'
  const m = /^v1 ([0-9a-f]{16}) ([A-Za-z0-9+/]{86}==)$/.exec(entry)
  if (m === null) return 'artifact signature is malformed'
  const key = keys.get(m[1]!)
  if (key === undefined)
    return `artifact is signed by a key this workspace does not trust (${m[1]})`
  const ok = verify(null, signedMessage(cacheKey, digestHex), key, Buffer.from(m[2]!, 'base64'))
  return ok ? null : 'artifact signature does not match its key and contents'
}

/**
 * The run's trust from the workspace's `cacheTrust.keys` and
 * `VX_CACHE_SIGNING_KEY`; undefined when neither is set, so nothing is
 * hashed or signed.
 */
export function cacheTrustOf(
  keys: readonly string[] | undefined,
  seed: string | undefined,
  where: string,
): CacheTrust | undefined {
  if ((keys === undefined || keys.length === 0) && (seed === undefined || seed === '')) {
    return undefined
  }
  return {
    keys: new Map((keys ?? []).map((k) => parseTrustKey(k, where))),
    signer: seed === undefined || seed === '' ? undefined : signerOf(seed),
  }
}
