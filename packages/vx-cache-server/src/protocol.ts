// The wire of vx-cache v1 (PROTOCOL.md): names, limits and the parsers of
// what a request carries. Every string a client sends is opaque to the
// server, which only compares it, so a client can send it encrypted.

/** The producing task's duration in whole milliseconds, on an artifact's PUT and its reads. */
export const DURATION_HEADER = 'x-artifact-duration'
/** The client's signature of an artifact, stored and returned as sent. */
export const TAG_HEADER = 'x-artifact-tag'
/** The commit, and the hash of uncommitted changes, an artifact was made at: stored and returned. */
export const SHA_HEADER = 'x-artifact-sha'
export const DIRTY_HASH_HEADER = 'x-artifact-dirty-hash'
/** The refs whose scopes a read walks, in order, before the trusted scope. */
export const READ_SCOPES_HEADER = 'x-artifact-read-scopes'

/** An artifact's hash, as Turbo's spec has it (hex), and at most 128 long. */
const HASH = /^[a-fA-F0-9]{1,128}$/
/** A key a history record carries: any opaque id. */
const KEY = /^[\w-]{1,128}$/
/** A string a history record carries: printable, bounded. */
const OPAQUE_MAX = 512
/** Turbo's spec caps `x-artifact-tag` at 600. */
export const TAG_MAX = 600
export const MAX_READ_SCOPES = 8
const REF_MAX = 255

export const isHash = (s: string): boolean => HASH.test(s)

export const isKey = (s: string): boolean => KEY.test(s)

export const isOpaque = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= OPAQUE_MAX

export const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A request the server refuses, answered as Turbo's spec's `Error`. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Turbo's spec's `Error`: `{ code, message }`. */
export function errorJson(status: number, message: string): Response {
  return Response.json({ code: CODES[status] ?? 'error', message }, { status })
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  500: 'internal_error',
  502: 'bad_gateway',
}

/**
 * `x-artifact-read-scopes`: an RFC 8941 list of strings, each a `refs/...` name,
 * at most 8, duplicates dropped. Absent or empty: no scope but the trusted one.
 */
export function parseReadScopes(value: string | null): string[] {
  if (value === null || value.trim() === '') return []
  const out: string[] = []
  let i = 0
  const skipSpace = (): void => {
    while (value[i] === ' ' || value[i] === '\t') i++
  }
  while (i < value.length) {
    skipSpace()
    if (value[i] !== '"') throw new Refusal(400, `${READ_SCOPES_HEADER}: not a list of strings`)
    i++
    let s = ''
    for (;;) {
      const c = value[i++]
      if (c === undefined) throw new Refusal(400, `${READ_SCOPES_HEADER}: unterminated string`)
      if (c === '"') break
      if (c === '\\') {
        const e = value[i++]
        if (e !== '"' && e !== '\\') throw new Refusal(400, `${READ_SCOPES_HEADER}: bad escape`)
        s += e
      } else if (c < ' ' || c > '~') {
        throw new Refusal(400, `${READ_SCOPES_HEADER}: not printable ASCII`)
      } else s += c
    }
    if (!s.startsWith('refs/') || s.length > REF_MAX) {
      throw new Refusal(400, `${READ_SCOPES_HEADER}: ${JSON.stringify(s)} is not a ref`)
    }
    if (!out.includes(s)) out.push(s)
    skipSpace()
    if (i < value.length) {
      if (value[i] !== ',') throw new Refusal(400, `${READ_SCOPES_HEADER}: not a list of strings`)
      i++
    }
  }
  if (out.length > MAX_READ_SCOPES) {
    throw new Refusal(400, `${READ_SCOPES_HEADER}: more than ${MAX_READ_SCOPES} refs`)
  }
  return out
}
