// The wire of vx-cache v1 (PROTOCOL.md): names, limits and the parsers of
// what a request carries. Every string a client sends is opaque to the
// server, which only compares it, so a client can send it encrypted.

import { Refusal } from '@vzn/vx/oidc'

/** The refs whose scopes a read walks, in order, before the trusted scope. */
export const READ_SCOPES_HEADER = 'x-artifact-read-scopes'

/**
 * The limits a server sets, as headers on every `/v1/artifacts/check`
 * answer: a client batches only by what it was told.
 */
export const LIMIT_HEADERS = {
  maxBatchArtifacts: 'x-vx-max-batch-artifacts',
  maxUploadBytes: 'x-vx-max-upload-bytes',
} as const

/** A batch upload's body: a JSON line, then the artifacts' bytes. */
export const BATCH_TYPE = 'application/vnd.vx-cache.batch'

/** An artifact's hash, as Turbo's spec has it (hex), and at most 128 long. */
const HASH = /^[a-fA-F0-9]{1,128}$/
/** A string a timing carries: bounded, and only compared. */
const OPAQUE_MAX = 512
export const MAX_READ_SCOPES = 8
const REF_MAX = 255

export const isHash = (s: string): boolean => HASH.test(s)

export const isOpaque = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= OPAQUE_MAX

export const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A request the server refuses, answered as Turbo's spec's `Error`. */
export { Refusal }

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
