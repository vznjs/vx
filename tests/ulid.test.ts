import { describe, expect, it } from 'bun:test'
import { ulid } from '../src/util/ulid.js'

describe('ulid (Bun.randomUUIDv7 wrapper)', () => {
  it('produces a 36-character UUIDv7 string', () => {
    const id = ulid()
    expect(id).toHaveLength(36)
    // UUIDv7 format: 8-4-4-4-12 hex with version "7" in the 13th char
    // and variant "8|9|a|b" in the 17th.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('many rapid generations are all unique', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(ulid())
    expect(ids.size).toBe(1000)
  })

  it('later IDs sort after earlier ones (timestamp-prefixed = lex-sortable)', async () => {
    const earlier = ulid()
    // Sleep > 1ms so the embedded ms-epoch timestamp differs.
    await Bun.sleep(5)
    const later = ulid()
    expect(later > earlier).toBe(true)
  })
})
