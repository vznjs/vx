import { describe, expect, it } from 'bun:test'
import {
  commandLine,
  remainingPath,
  sentence,
  simulate,
  statusLabel,
  summaryParts,
  STORY_TASKS,
  type Run,
} from '../src/components/play/model/run-timeline.js'

const byId = (run: Run, id: string) => run.outcomes.find((o) => o.id === id)!
const words = (run: Run) =>
  summaryParts(run)
    .map((p) => p.text)
    .join(' · ')

describe('run timeline model', () => {
  it('runs every task when nothing fails, never more than `concurrency` at once', () => {
    for (const concurrency of [1, 2, 3, 4]) {
      const run = simulate({ concurrency, failFast: false })
      expect(run.counts).toEqual({ success: 8, failed: 0, skipped: 0, aborted: 0 })
      for (let t = 0; t < run.end; t++) {
        const busy = run.outcomes.filter((o) => o.start! <= t && t < o.end!)
        expect(busy.length).toBeLessThanOrEqual(concurrency)
        expect(new Set(busy.map((o) => o.lane)).size).toBe(busy.length)
      }
    }
  })

  it('starts a task only after what it depends on ended', () => {
    const run = simulate({ concurrency: 4, failFast: false })
    for (const t of STORY_TASKS)
      for (const d of t.deps)
        expect(byId(run, t.id).start!).toBeGreaterThanOrEqual(byId(run, d).end!)
  })

  it('runs the longest remaining path first', () => {
    expect(remainingPath(STORY_TASKS).get('@demo/ui#build')).toBe(7)
    const run = simulate({ concurrency: 1, failFast: false })
    expect(byId(run, '@demo/ui#build').start).toBe(0)
    expect(byId(run, '@demo/ui#lint').start).toBeGreaterThan(byId(run, '@demo/ui#test').start!)
  })

  it('more slots finish sooner', () => {
    const ends = [1, 2, 3, 4].map((concurrency) => simulate({ concurrency, failFast: false }).end)
    expect(ends[0]).toBe(17)
    for (let i = 1; i < ends.length; i++) expect(ends[i]!).toBeLessThanOrEqual(ends[i - 1]!)
  })

  it('by default, a failure skips only its dependents and the rest runs on', () => {
    const run = simulate({ concurrency: 2, fail: '@demo/ui#build', failFast: false })
    expect(byId(run, '@demo/ui#build').status).toBe('failed')
    expect(statusLabel(byId(run, '@demo/web#build'))).toBe('skipped (blocked by @demo/ui#build)')
    expect(byId(run, '@demo/web#test').status).toBe('skipped')
    expect(byId(run, '@demo/web#build').start).toBeUndefined()
    for (const id of ['@demo/ui#test', '@demo/ui#lint', '@demo/web#lint', '@demo/docs#build'])
      expect(byId(run, id).status).toBe('success')
    expect(words(run)).toBe('1 failed · 5 success · 2 skipped · 8 total')
  })

  it('a failure nothing waits on skips nothing', () => {
    const run = simulate({ concurrency: 2, fail: '@demo/ui#test', failFast: false })
    expect(run.counts).toEqual({ success: 7, failed: 1, skipped: 0, aborted: 0 })
  })

  it('--fail-fast kills what runs and starts nothing more', () => {
    const run = simulate({ concurrency: 2, fail: '@demo/ui#build', failFast: true })
    const failedAt = byId(run, '@demo/ui#build').end!
    const docs = byId(run, '@demo/docs#build')
    expect(docs.status).toBe('aborted')
    expect(docs.end).toBe(failedAt)
    expect(run.end).toBe(failedAt)
    for (const o of run.outcomes) if (o.start !== undefined) expect(o.start).toBeLessThan(failedAt)
    // A skip with nothing failed upstream is the stop's: bare, as vx prints it.
    expect(statusLabel(byId(run, '@demo/ui#lint'))).toBe('skipped')
    expect(statusLabel(byId(run, '@demo/web#build'))).toBe('skipped (blocked by @demo/ui#build)')
    expect(words(run)).toBe('1 failed · 1 success · 5 skipped · 1 aborted · 8 total')
  })

  it('says what one slot would cost', () => {
    const opts = { concurrency: 2, failFast: false }
    expect(sentence(simulate(opts), opts)).toBe(
      'Everything ran. 2 at a time, the run took 9 units. One at a time would take 17.',
    )
  })

  it('names the flags the controls stand for', () => {
    expect(commandLine({ concurrency: 3, failFast: true })).toBe(
      'vx run build test lint --concurrency 3 --fail-fast',
    )
  })
})
