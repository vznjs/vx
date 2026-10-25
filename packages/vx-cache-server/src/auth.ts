// Who may read and write: bearer tokens, listed by their SHA-256 so the
// list is no secret (`TOKENS`, PROTOCOL.md § Tokens).

import { Refusal } from './protocol.js'
import { TRUSTED } from './store.js'

/** What a request may do: read its namespace, and write to `write` when set. */
export interface Access {
  ns: string
  write?: string
}

export type Authorize = (req: Request) => Promise<Access>

/** The namespace every listed token reads and writes. */
const NS = 'default'

/**
 * `TOKENS`' entries, space or comma separated, each `read:<sha256>` or
 * `write:<sha256>`: the hex SHA-256 of a token, which `Authorization:
 * Bearer <token>` carries. A write token stores to the trusted scope.
 */
export function parseTokens(list: string): Map<string, Access> {
  const tokens = new Map<string, Access>()
  for (const entry of list.split(/[\s,]+/)) {
    if (entry === '') continue
    const m = /^(read|write):([0-9a-f]{64})$/.exec(entry.toLowerCase())
    if (m === null) throw new Error(`${entry} is not read:<sha256> or write:<sha256>`)
    tokens.set(m[2]!, m[1] === 'write' ? { ns: NS, write: TRUSTED } : { ns: NS })
  }
  return tokens
}

export function tokenAuth(tokens: ReadonlyMap<string, Access>): Authorize {
  return async (req) => {
    if (tokens.size === 0) throw new Refusal(401, 'the server lists no token: set TOKENS')
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    if (m === null) throw new Refusal(401, 'no bearer token')
    const access = tokens.get(await sha256(m[1]!))
    if (access === undefined) throw new Refusal(401, 'unknown token')
    return access
  }
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  // No Buffer: Workers have it only under nodejs_compat.
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
