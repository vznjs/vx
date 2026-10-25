// The wire of vx-cache v1 (PROTOCOL.md): names, limits and the parsers of
// what a request carries. Every string a client sends is opaque to the
// server, which only compares it, so a client can send it encrypted.

/** The producing task's duration in whole milliseconds, on an artifact's PUT and its reads. */
export const DURATION_HEADER = 'vx-duration'
/** The refs whose scopes a read walks, in order, before the trusted scope. */
export const READ_SCOPES_HEADER = 'vx-read-scopes'

/** A key: an artifact's, or any opaque id (a run's, a task's). */
const KEY = /^[\w-]{1,128}$/
/** A string a history record carries: printable, bounded. */
const OPAQUE_MAX = 512
export const MAX_READ_SCOPES = 8
const REF_MAX = 255

export const isKey = (s: string): boolean => KEY.test(s)

export const isOpaque = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= OPAQUE_MAX

export const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A request the server refuses, answered as RFC 9457 problem details. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function problem(status: number, detail: string): Response {
  return Response.json(
    { type: 'about:blank', title: TITLES[status] ?? 'Error', status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  )
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  411: 'Length Required',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
}

/**
 * `Vx-Read-Scopes`: an RFC 8941 list of strings, each a `refs/...` name,
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
