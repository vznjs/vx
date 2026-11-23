// The quote rows (2026-11-19, desktop 2026-11-23): a finger, trackpad or
// mouse scrolls them, and they drift on, looping, from where it let go.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { DRIFT_SPEED, drift, fold } from '../src/components/landing/drift.ts'

describe('a quote row', () => {
  it('keeps its offset in the middle copy, whichever way it went', () => {
    expect(fold(1000, 1000)).toBe(1000)
    expect(fold(1999, 1000)).toBe(1999)
    expect(fold(2000, 1000)).toBe(1000)
    expect(fold(2250, 1000)).toBe(1250)
    expect(fold(250, 1000)).toBe(1250)
    expect(fold(0, 1000)).toBe(1000)
  })

  it('drifts at the desktop pace, left or right, across the seam', () => {
    expect(drift(1000, 280, -1, 1000)).toBe(1010)
    expect(drift(1500, 280, 1, 1000)).toBe(1490)
    expect(drift(1000, 280, 1, 1000)).toBe(1990)
    expect(drift(1995, 280, -1, 1000)).toBe(1005)
    expect(DRIFT_SPEED).toBe(1 / 28)
  })

  it('shows its edges plainly on a phone, with no fade', () => {
    const css = readFileSync(path.resolve(import.meta.dir, '../src/styles/voices.css'), 'utf8')
    const phone = /@media \(max-width: 620px\) \{([\s\S]*)\}\s*$/.exec(css)![1]!
    expect(phone).toMatch(/\.sky \{[^}]*mask-image: none;/)
  })
})
