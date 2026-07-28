// The Insights timeframe selector's token → window resolution. Pinned so the
// preset chips (24h/7d/30d/90d) map to the right day windows, an absent/invalid
// value falls back to each source's own default (pages without the selector
// stay byte-identical), and trends switch to hourly buckets only for 24h.

import { describe, expect, it } from 'bun:test'
import { foldTaskTrendPoints, trendArgsOf, windowDaysOf } from './data.ts'

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

describe('foldTaskTrendPoints', () => {
  const pt = (task: string, t: number, avg: number, failures = 0) => ({
    task,
    t,
    avgDurationMs: avg,
    failures,
  })

  it('drops 0-avg sentinel buckets (all-hit / all-failed) from the drawn series', () => {
    // Day 2 had only a failure → server emits avg 0. It must not plot as a
    // to-zero dip, and the LATEST value must be the last EXECUTED duration.
    const items = foldTaskTrendPoints('app', [
      pt('build', 1000, 500),
      pt('build', 2000, 0, 1),
      pt('build', 3000, 600),
      pt('build', 4000, 0, 1),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.series).toEqual([500, 600])
    expect(items[0]!._latest).toBe(600)
    expect(items[0]!._failures).toBe(2)
  })

  it('an all-sentinel task keeps an empty series and a 0 latest (honest empty)', () => {
    const items = foldTaskTrendPoints('app', [pt('hits-only', 1000, 0), pt('hits-only', 2000, 0)])
    expect(items[0]!.series).toEqual([])
    expect(items[0]!._latest).toBe(0)
    expect(items[0]!._trend).toBe('flat')
  })

  it('trend reads the executed series ends: slower → up, faster → down, one point → flat', () => {
    const up = foldTaskTrendPoints('app', [pt('a', 1, 100), pt('a', 2, 0, 1), pt('a', 3, 200)])
    expect(up[0]!._trend).toBe('up')
    expect(up[0]!._dir).toBe('slower')
    const down = foldTaskTrendPoints('app', [pt('a', 1, 200), pt('a', 2, 100)])
    expect(down[0]!._trend).toBe('down')
    const single = foldTaskTrendPoints('app', [pt('a', 1, 0), pt('a', 2, 500)])
    expect(single[0]!._trend).toBe('flat')
  })

  // F6. The arrow used to be decided by the FIRST and LAST bucket against a
  // hardcoded ±10%, so one lucky or loaded day set the verdict — and could
  // invert it against the window's actual movement.
  describe('the trend arrow survives a single lucky or loaded bucket', () => {
    const flat6 = (avgs: number[], noiseCv?: number) =>
      foldTaskTrendPoints(
        'app',
        avgs.map((avg, i) => ({
          task: 'a',
          t: i + 1,
          avgDurationMs: avg,
          failures: 0,
          ...(noiseCv !== undefined ? { noiseCv } : {}),
        })),
      )[0]!

    it('a 15% opening bucket does not invert a flat task', () => {
      // The sharp case: this used to read 'up' (red, "slower") while the
      // window's own mean had gone DOWN.
      expect(flat6([850, 1000, 1000, 1000, 1000, 1000])._trend).toBe('flat')
      expect(flat6([1150, 1000, 1000, 1000, 1000, 1000])._trend).toBe('flat')
    })

    it('a 15% closing bucket does not flag a flat task', () => {
      expect(flat6([1000, 1000, 1000, 1000, 1000, 1150])._trend).toBe('flat')
    })

    it('the band is the task’s MEASURED spread, not a guessed 10%', () => {
      // Same 20% drift, judged twice. A task measured at cv=0.30 is simply
      // this variable, so the movement is inside its own noise.
      const drift = [1000, 1000, 1000, 1200, 1200, 1200]
      expect(flat6(drift)._trend).toBe('up')
      expect(flat6(drift, 0.3)._trend).toBe('flat')
    })

    it('a real sustained move is still called, both directions', () => {
      expect(flat6([1000, 1000, 1000, 2000, 2000, 2000], 0.05)._trend).toBe('up')
      expect(flat6([2000, 2000, 2000, 1000, 1000, 1000], 0.05)._dir).toBe('faster')
    })
  })

  it('sorts slowest-latest on top and time-orders unsorted rows', () => {
    const items = foldTaskTrendPoints('app', [
      pt('slow', 2000, 900),
      pt('fast', 1000, 50),
      pt('slow', 1000, 100), // arrives out of order — must sort before 2000
    ])
    expect(items.map((i) => i.task)).toEqual(['slow', 'fast'])
    expect(items[0]!.series).toEqual([100, 900])
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
