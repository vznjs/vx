// The home page's conformance count, run up as its band comes near.

import { describe, expect, it } from 'bun:test'
import { COUNT_MS, countAt } from '../src/components/landing/count.ts'

describe('the conformance count', () => {
  it('holds at 0 when a frame began before the count started', () => {
    expect(countAt(1021, -1190)).toBe(0)
    expect(countAt(1021, -1)).toBe(0)
  })

  it('runs up from 0 and stops at the real count', () => {
    expect(countAt(1021, 0)).toBe(0)
    expect(countAt(1021, COUNT_MS / 2)).toBeGreaterThan(0)
    expect(countAt(1021, COUNT_MS / 2)).toBeLessThan(1021)
    expect(countAt(1021, COUNT_MS)).toBe(1021)
    expect(countAt(1021, COUNT_MS * 3)).toBe(1021)
  })
})
