// HMAC-SHA256 over (hash || teamId || body) — Turbo wire compatible.
// Mirrors src/cache/remote-cache.ts (HMAC validation on PUT, verify on
// GET, hard-fail-on-missing-tag-when-key-is-set).

const enc = new TextEncoder()

async function importKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!)
  return btoa(bin)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Compute the tag for `(hash, teamId, body)`. */
export async function computeArtifactTag(
  secret: string,
  hash: string,
  teamId: string,
  body: ArrayBuffer,
): Promise<string> {
  const key = await importKey(secret)
  const prefix = enc.encode(hash + teamId)
  const buf = new Uint8Array(prefix.length + body.byteLength)
  buf.set(prefix, 0)
  buf.set(new Uint8Array(body), prefix.length)
  const sig = await crypto.subtle.sign('HMAC', key, buf)
  return toBase64(sig)
}

/** Verify a tag in constant time. */
export async function verifyArtifactTag(
  secret: string,
  hash: string,
  teamId: string,
  body: ArrayBuffer,
  expectedTag: string,
): Promise<boolean> {
  const key = await importKey(secret)
  const prefix = enc.encode(hash + teamId)
  const buf = new Uint8Array(prefix.length + body.byteLength)
  buf.set(prefix, 0)
  buf.set(new Uint8Array(body), prefix.length)
  let expectedBytes: Uint8Array
  try {
    expectedBytes = fromBase64(expectedTag)
  } catch {
    return false
  }
  return await crypto.subtle.verify('HMAC', key, expectedBytes, buf)
}
