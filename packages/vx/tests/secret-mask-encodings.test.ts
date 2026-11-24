// A secret printed as a tool encodes it leaked whole: a token with `/`, `+`
// or `=` in a query string (`%2F%2B%3D`), or a value holding a quote,
// backslash or newline inside a JSON string (`\"`, `\\`, `\n`). Each
// spelling is masked, as the plain value is.
import { describe, expect, it } from 'bun:test'
import { MASKED, secretMask } from '../src/util/index.js'

const TOKEN = 'ab/cd+ef=gh-sekret'
const QUOTED = 'pa"ss\\word\nline-two'

describe('a secret in its encoded spellings', () => {
  const mask = secretMask([{ API_TOKEN: TOKEN, DB_PASSWORD: QUOTED }])!

  it('masks the URL-encoded value', () => {
    expect(mask.mask(`GET /x?token=${encodeURIComponent(TOKEN)}&a=1`)).toBe(
      `GET /x?token=${MASKED}&a=1`,
    )
  })

  it('masks the value inside a JSON string', () => {
    const line = JSON.stringify({ password: QUOTED, token: TOKEN })
    expect(line).not.toContain(QUOTED)
    const masked = mask.mask(line)
    expect(masked).not.toContain(JSON.stringify(QUOTED).slice(1, -1))
    expect(masked).toBe(`{"password":"${MASKED}","token":"${MASKED}"}`)
  })

  it('masks a split encoded value across two chunks', () => {
    const enc = encodeURIComponent(TOKEN)
    const s = mask.stream()
    const out = s.push(`t=${enc.slice(0, 5)}`) + s.push(`${enc.slice(5)} done`) + s.end()
    expect(out).toBe(`t=${MASKED} done`)
  })

  // A percent escape's hex is either case (RFC 3986 § 2.1): Python's
  // quote() and JS print `%2F`, others `%2f`, and a lower or mixed one
  // printed the token whole.
  it('masks the URL-encoded value with its hex in lower or mixed case', () => {
    const enc = encodeURIComponent(TOKEN)
    const lower = enc.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())
    let n = 0
    const mixed = enc.replace(/%[0-9A-F]{2}/g, (e) => (n++ % 2 === 0 ? e.toLowerCase() : e))
    expect([lower, mixed].every((v) => v !== enc)).toBe(true)
    for (const v of [lower, mixed])
      expect(mask.mask(`?token=${v}&a=1`)).toBe(`?token=${MASKED}&a=1`)
    const s = mask.stream()
    const out = s.push(`t=${lower.slice(0, 5)}`) + s.push(`${lower.slice(5)} done`) + s.end()
    expect(out).toBe(`t=${MASKED} done`)
    expect(mask.maskCut(`t=${lower.slice(0, 5)}`, `${lower.slice(9)} done`)).toEqual([
      `t=${MASKED}`,
      `${MASKED} done`,
    ])
  })

  // Each tool encodes its own set: Python's quote() keeps `/`, curl and
  // quote_plus() write a space as `+` and escape `!'()*`, URLSearchParams
  // escapes `~` and keeps `*`. Only encodeURIComponent's spelling was masked.
  it("masks the value as Python's quote(), curl and URLSearchParams spell it", () => {
    const value = "ab/cd+ef=gh-sekret!x*y(z)'~ s"
    const tools = secretMask([{ API_TOKEN: value }])!
    for (const spelled of [
      'ab/cd%2Bef%3Dgh-sekret%21x%2Ay%28z%29%27~%20s', // quote()
      'ab%2Fcd%2Bef%3Dgh-sekret%21x%2Ay%28z%29%27~%20s', // quote(safe='')
      'ab%2fcd%2bef%3dgh-sekret%21x%2ay%28z%29%27~+s', // curl --data-urlencode, quote_plus()
      'ab%2Fcd%2Bef%3Dgh-sekret%21x*y%28z%29%27%7E+s', // URLSearchParams
    ])
      expect(tools.mask(`?t=${spelled}&a=1`)).toBe(`?t=${MASKED}&a=1`)
  })

  it('CONTROL: a value with nothing to encode is masked once, as before', () => {
    const plain = secretMask([{ API_TOKEN: 'plainsekretvalue1' }])!
    expect(plain.mask('x plainsekretvalue1 y')).toBe(`x ${MASKED} y`)
  })
})
