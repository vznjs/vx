import { describe, expect, it } from 'bun:test'
import { defineProject } from '../../src/project/define.ts'

describe('defineProject', () => {
  it('returns its argument unchanged', () => {
    const input = {} as const
    expect(defineProject(input)).toBe(input)
  })
})
