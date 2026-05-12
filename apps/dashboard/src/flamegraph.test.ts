import { describe, it, expect } from 'bun:test'
import { colorForTask, computeLayout } from './flamegraph.ts'
import type { TaskRow } from './api.ts'

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 1,
    hash: 'h',
    project: 'p',
    task: 't',
    status: 'success',
    exitCode: 0,
    durationMs: 100,
    startedAt: 0,
    endedAt: 100,
    runId: 'R',
    cpuMs: null,
    peakRssBytes: null,
    wallclockStartNs: null,
    wallclockEndNs: null,
    cacheHit: false,
    bytesUploaded: null,
    bytesDownloaded: null,
    ...over,
  }
}

describe('computeLayout', () => {
  it('returns an empty layout for no tasks', () => {
    expect(computeLayout([])).toEqual({ bars: [], lanes: [], totalDurationMs: 0 })
  })

  it('groups tasks into one lane per project, preserving first-seen order', () => {
    const layout = computeLayout([
      task({ project: 'app', task: 'build' }),
      task({ project: 'lib', task: 'test' }),
      task({ project: 'app', task: 'test' }),
    ])
    expect(layout.lanes).toEqual(['app', 'lib'])
    expect(layout.bars.map((b) => b.laneIndex)).toEqual([0, 1, 0])
  })

  it('uses ns-precise spans when present', () => {
    const layout = computeLayout([
      task({
        wallclockStartNs: '0',
        wallclockEndNs: '500000000',
        startedAt: 1_000_000_000,
        endedAt: 1_000_000_500,
      }),
      task({
        wallclockStartNs: '200000000',
        wallclockEndNs: '900000000',
        startedAt: 1_000_000_200,
        endedAt: 1_000_000_900,
      }),
    ])
    expect(layout.bars[0]).toMatchObject({ startMs: 0, endMs: 500 })
    expect(layout.bars[1]).toMatchObject({ startMs: 200, endMs: 900 })
    expect(layout.totalDurationMs).toBe(900)
  })

  it('falls back to startedAt/endedAt when ns spans are missing', () => {
    const layout = computeLayout([
      task({ startedAt: 1000, endedAt: 1200 }),
      task({ startedAt: 1100, endedAt: 1700 }),
    ])
    expect(layout.bars[0]).toMatchObject({ startMs: 0, endMs: 200 })
    expect(layout.bars[1]).toMatchObject({ startMs: 100, endMs: 700 })
    expect(layout.totalDurationMs).toBe(700)
  })
})

describe('colorForTask', () => {
  it('classifies by status + cacheHit', () => {
    expect(colorForTask(task({ status: 'success' }))).toBe('ok')
    expect(colorForTask(task({ status: 'failed' }))).toBe('err')
    expect(colorForTask(task({ status: 'success', cacheHit: true }))).toBe('cache')
    expect(colorForTask(task({ status: 'cache-hit' }))).toBe('cache')
    expect(colorForTask(task({ status: 'mystery' }))).toBe('neutral')
  })
})
