// The wire of vx-cache v1 (PROTOCOL.md): names, limits and the parsers of
// what a request carries. Every string a client sends is opaque to the
// server, which only compares it, so a client can send it encrypted.

/** The scope (a ref's hash) a download reads: `GET /v1/artifacts/<hash>`. */
export const SCOPE_HEADER = 'vx-scope'

/**
 * The limits a server sets, as headers on every `/v1/artifacts`
 * answer: a client batches checks only by what it was told.
 */
export const LIMIT_HEADERS = {
  maxCheckHashes: 'vx-max-check-hashes',
  maxUploadBytes: 'vx-max-upload-bytes',
} as const

/** An artifact's hash, as Turbo's spec has it (hex), and at most 128 long. */
const HASH = /^[a-fA-F0-9]{1,128}$/

export const isHash = (s: string): boolean => HASH.test(s)

export const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
