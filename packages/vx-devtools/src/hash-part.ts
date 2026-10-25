// What a server stores in place of an issuer, a repository name or a scope
// (M, 2026-10-25: "issuer and scope should be hashed"): a cache object's
// name and a history row hold no plain value of a token's.

const parts = new Map<string, Promise<string>>()

/**
 * SHA-256's first 128 bits of `text` in hex. Web Crypto, so Bun and
 * Workers name alike; a few strings recur per node, so each is hashed once.
 */
export function hashPart(text: string): Promise<string> {
  let got = parts.get(text)
  if (got === undefined) {
    if (parts.size >= 10_000) parts.clear()
    got = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(text))
      .then((d) =>
        [...new Uint8Array(d, 0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      )
    parts.set(text, got)
  }
  return got
}
