// A multi-line secret (a PEM key) was masked only as a whole: a tool that
// indented or reflowed it printed every line in the clear (L-36). Each
// line is now masked too, as GitHub Actions does.
import { describe, expect, it } from 'bun:test'
import { secretMask } from '../src/util/secret-mask.js'

const KEY = [
  '-----BEGIN KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  '-----END KEY-----',
].join('\n')

describe('secretMask — a multi-line value', () => {
  const mask = secretMask([{ SSH_PRIVATE_KEY: KEY }])!

  it('masks it whole, and each line printed on its own', () => {
    expect(mask.mask(KEY)).toBe('***')
    const indented = KEY.split('\n')
      .map((l) => `  ${l}`)
      .join('\n')
    expect(mask.mask(indented)).toBe('  ***\n  ***\n  ***\n  ***')
  })

  it('masks a line split across stream chunks', () => {
    const s = mask.stream()
    const out = s.push('x MIIEvQIBADANBg') + s.push('kqhkiG9w0BAQEFAASC y\n') + s.end()
    expect(out).toBe('x *** y\n')
  })

  it('leaves a line shorter than the minimum alone', () => {
    const short = secretMask([{ API_KEY: 'abcdefgh\nxy' }])!
    expect(short.mask('xy abcdefgh')).toBe('xy ***')
  })
})
