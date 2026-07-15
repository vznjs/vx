// The Insights timeframe selector's token → window resolution. Pinned so the
// preset chips (24h/7d/30d/90d) map to the right day windows, an absent/invalid
// value falls back to each source's own default (pages without the selector
// stay byte-identical), and trends switch to hourly buckets only for 24h.

import { describe, expect, it } from 'bun:test'
import { trendArgsOf, windowDaysOf } from './data.ts'

const DAY = 24 * 60 * 60 * 1000

describe('windowDaysOf', () => {
  it('maps each preset token to its day window', () => {
    expect(windowDaysOf({ window: '24h' }, 30)).toBe(1)
    expect(windowDaysOf({ window: '7d' }, 30)).toBe(7)
    expect(windowDaysOf({ window: '30d' }, 1)).toBe(30)
    expect(windowDaysOf({ window: '90d' }, 30)).toBe(90)
  })

  it('falls back to the caller default when the token is absent or invalid', () => {
    expect(windowDaysOf({}, 30)).toBe(30)
    expect(windowDaysOf({}, 1)).toBe(1)
    expect(windowDaysOf({ window: 'bogus' }, 14)).toBe(14)
    expect(windowDaysOf({ window: '' }, 7)).toBe(7)
  })
})

describe('trendArgsOf', () => {
  it('uses hourly buckets over the last day for a 24h window', () => {
    const a = trendArgsOf({ window: '24h' })
    expect(a.bucket).toBe('hour')
    expect(a.to - a.from).toBe(DAY)
  })

  it('uses daily buckets over the span for longer windows (and the 30d default)', () => {
    const a = trendArgsOf({ window: '90d' })
    expect(a.bucket).toBe('day')
    expect(a.to - a.from).toBe(90 * DAY)
    // Absent → the default 30-day daily span.
    const d = trendArgsOf({})
    expect(d.bucket).toBe('day')
    expect(d.to - d.from).toBe(30 * DAY)
  })
})
