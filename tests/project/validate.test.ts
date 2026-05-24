import { describe, expect, it } from 'bun:test'
import { validateProject } from '../../src/project/validate.ts'

describe('validateProject', () => {
  it('returns the input unchanged when it matches the schema', () => {
    expect(validateProject({})).toEqual({})
  })

  it('throws on unknown fields (schema is strict)', () => {
    expect(() => validateProject({ whatever: 7 })).toThrow(/whatever/)
  })

  it('throws on non-object input', () => {
    expect(() => validateProject(42)).toThrow()
    expect(() => validateProject('foo')).toThrow()
    expect(() => validateProject(null)).toThrow()
    expect(() => validateProject(undefined)).toThrow()
  })
})
