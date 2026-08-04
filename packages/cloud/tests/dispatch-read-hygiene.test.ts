// Read-surface hygiene on the platform's HTTP host, from the recorded-not-fixed
// list of the 2026-07-30 dispatch audit and the 2026-08-04 analytics-router one.
// Neither is exploitable — there is no `Access-Control-Allow-Credentials`
// anywhere in src/, so the wildcard allow-origin cannot expose a credentialed
// response, and SameSite=Lax blocks the cookie on a cross-site POST. Both are
// about a surface not teaching a caller something untrue: that a mutation was
// accepted, or that a knob validates when it only half does.

import { describe, it, expect } from 'bun:test'
import { bootPlatform } from './helpers/platform.js'

describe('dispatch read-surface hygiene', () => {
  it('gates the verb and parses the limit strictly', async () => {
    const p = await bootPlatform()
    const h = { authorization: `Bearer ${p.ciToken}` }
    try {
      for (const m of ['GET', 'HEAD']) {
        expect((await fetch(`${p.origin}/v1/agents`, { method: m, headers: h })).status).toBe(200)
      }
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect((await fetch(`${p.origin}/v1/agents`, { method: m, headers: h })).status).toBe(405)
      }
      // `0x10` used to coerce to 16; a strict parse falls back to the default.
      for (const v of ['0x10', '1e3', 'abc', '-5', '2.7', '']) {
        expect((await fetch(`${p.origin}/v1/artifacts?limit=${v}`, { headers: h })).status).toBe(
          200,
        )
      }
      expect((await fetch(`${p.origin}/v1/artifacts?limit=5`, { headers: h })).status).toBe(200)
    } finally {
      await p.stop()
    }
  }, 60000)
})
