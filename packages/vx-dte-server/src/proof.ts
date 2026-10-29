// The orchestrator's key (PROTOCOL.md "The orchestrator's key"): its join
// names a P-256 public key the relay keeps for the run, and each later
// request as the orchestrator carries a signature by it, so only the side
// holding the private key acts as the run's orchestrator.

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
const text = new TextEncoder()

/** The header a request as the host proves itself in. */
export const PROOF_HEADER = 'relay-proof'

/** What a proof signs: the request, when, and a nonce the relay sees once. */
export function proofText(
  method: string,
  path: string,
  ts: number,
  nonce: string,
  body: string,
): Uint8Array<ArrayBuffer> {
  return text.encode(`switchboard-proof\0${method}\0${path}\0${ts}\0${nonce}\0${body}`)
}

/** A run's orchestrator key: `key` its join names, `proof` the header of each request. */
export interface Prover {
  /** The public key, raw and base64url. */
  readonly key: string
  /** `path` is the request URL's path and query. */
  proof(method: string, path: string, body: string): Promise<string>
}

/** A new key for one run; it never leaves this process. */
export async function createProver(): Promise<Prover> {
  const pair = (await crypto.subtle.generateKey(ALG, false, ['sign', 'verify'])) as CryptoKeyPair
  const key = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return {
    key,
    async proof(method, path, body) {
      const ts = Date.now()
      const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)))
      const sig = await crypto.subtle.sign(
        SIGN,
        pair.privateKey,
        proofText(method, path, ts, nonce, body),
      )
      return `${ts}.${nonce}.${b64u(new Uint8Array(sig))}`
    },
  }
}

/** A key a join named; rejects one that is not a P-256 point. */
export async function importKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', unb64u(raw), ALG, false, ['verify'])
}

export async function verifyProof(
  key: CryptoKey,
  sig: string,
  signed: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  // A signature that is not base64url is a bad one: atob threw out of the relay (a 500).
  try {
    return await crypto.subtle.verify(SIGN, key, unb64u(sig), signed)
  } catch {
    // quiet: a signature that cannot be read is a bad one: false is the answer
    return false
  }
}

// No Buffer: a Worker has none.
function b64u(b: Uint8Array): string {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
