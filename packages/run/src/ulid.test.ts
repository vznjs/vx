import { describe, expect, it } from 'bun:test'
import { ulid } from './ulid.js'

describe('ulid', () => {
  it('produces a 26-character Crockford-base32 string', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
  })

  it('two ids generated in the same ms are unique (random suffix differs)', () => {
    const now = Date.now()
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(ulid(now))
    expect(ids.size).toBe(1000)
  })

  it('two ids generated 1ms apart sort with the later one greater', () => {
    const earlier = ulid(1_700_000_000_000)
    const later = ulid(1_700_000_000_001)
    expect(later > earlier).toBe(true)
  })

  it('time prefix is deterministic for a fixed timestamp', () => {
    // Same timestamp → same first-10-char prefix (only random suffix varies).
    const a = ulid(1_700_000_000_000)
    const b = ulid(1_700_000_000_000)
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a.slice(10)).not.toBe(b.slice(10))
  })
})
