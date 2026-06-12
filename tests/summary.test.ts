import { describe, expect, it } from 'bun:test'
import { formatDuration, formatRunSummary } from '../src/orchestrator/summary.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function outcome(id: string, status: TaskOutcome['status'], exitCode = 0): TaskOutcome {
  return {
    // Minimal TaskNode shape, with `exec` set so `isGroupTask` returns
    // false. The shared `tallyOutcomes` helper filters group tasks
    // out — `node.config.exec` must be defined for these test
    // outcomes to count toward the totals.
    node: { id, config: { exec: { command: 'noop' } } } as TaskNode,
    status,
    exitCode,
    durationMs: 100,
  }
}

describe('formatRunSummary', () => {
  it('all successful, no cache hits', () => {
    const lines = formatRunSummary([outcome('a#x', 'success'), outcome('b#x', 'success')], 1234)
    expect(lines).toEqual([
      '',
      ' Tasks:    2 successful, 2 total',
      'Cached:    0 cached, 2 total',
      '  Time:    1.23s',
    ])
  })

  it('mix of local + remote cache hits', () => {
    const lines = formatRunSummary(
      [
        outcome('a#lint', 'cache-hit'),
        outcome('b#lint', 'cache-hit-remote'),
        outcome('c#lint', 'success'),
      ],
      420,
    )
    expect(lines[1]).toBe(' Tasks:    3 successful, 3 total')
    expect(lines[2]).toBe('Cached:    0 local-restore, 0 remote-restore, 2 up-to-date, 3 total')
    expect(lines[3]).toBe('  Time:    420ms')
  })

  it('reports failures separately from total', () => {
    const lines = formatRunSummary(
      [outcome('a#test', 'success'), outcome('b#test', 'failed', 1)],
      850,
    )
    expect(lines[1]).toBe(' Tasks:    1 successful, 1 failed, 2 total')
    expect(lines[2]).toBe('Cached:    0 cached, 2 total')
  })

  it('lists failed task IDs on a single comma-joined line (Turbo format)', () => {
    // Mirrors Turbo's run-summary format
    // (turborepo-run-summary/src/execution.rs): one `Failed:` line,
    // comma-joined task IDs in bold red, sorted. Lets the user
    // identify what failed without scrolling back through framed
    // blocks.
    const lines = formatRunSummary(
      [
        outcome('@app/web#build', 'failed', 1),
        outcome('@app/api#test', 'failed', 2),
        outcome('lib#build', 'success'),
      ],
      1234,
    )
    expect(lines).toContain('Failed:    @app/api#test, @app/web#build')
  })

  it('omits the Failed: line when no tasks failed', () => {
    const lines = formatRunSummary([outcome('a#x', 'success')], 10)
    expect(lines.find((l) => l.startsWith('Failed:'))).toBeUndefined()
  })

  it('does not list skipped tasks separately (Turbo parity)', () => {
    // Turbo doesn't surface "skipped" as a list — it's inferred from
    // a failed upstream, and the failing upstream IS listed. Pin
    // this so future changes don't reintroduce duplicate noise.
    const lines = formatRunSummary([outcome('a#x', 'failed', 1), outcome('b#x', 'skipped')], 10)
    expect(lines.find((l) => l.startsWith('Skipped:'))).toBeUndefined()
    expect(lines).toContain('Failed:    a#x')
  })

  it('reports skipped count when present', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success'), outcome('b#x', 'failed', 2), outcome('c#x', 'skipped')],
      50,
    )
    expect(lines[1]).toBe(' Tasks:    1 successful, 1 failed, 1 skipped, 3 total')
  })

  it('treats cache-hit-remote as successful', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit-remote')], 10)
    expect(lines[1]).toBe(' Tasks:    1 successful, 1 total')
    expect(lines[2]).toBe('Cached:    0 local-restore, 0 remote-restore, 1 up-to-date, 1 total')
  })

  it('appends >>> FULL CACHE when every real task came from the cache', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'cache-hit'), outcome('b#x', 'cache-hit-remote')],
      42,
    )
    expect(lines[3]).toBe('  Time:    42ms >>> FULL CACHE')
  })

  it('omits >>> FULL CACHE when at least one task actually ran', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit'), outcome('b#x', 'success')], 42)
    expect(lines[3]).toBe('  Time:    42ms')
  })

  it('omits >>> FULL CACHE on an empty run (no tasks)', () => {
    const lines = formatRunSummary([], 0)
    expect(lines[3]).toBe('  Time:    0ms')
  })

  it('injects ANSI escapes around counts + FULL CACHE when colors are enabled', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit'), outcome('b#x', 'failed', 1)], 42, {
      enabled: true,
    })
    // success count colorized
    expect(lines[1]).toContain('\x1b[')
    expect(lines[1]).toContain('1 successful')
    expect(lines[1]).toContain('1 failed')
  })

  it('FULL CACHE motif gets bold + green when colors are enabled', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit')], 10, { enabled: true })
    expect(lines[3]).toContain('>>> FULL CACHE')
    expect(lines[3]).toContain('\x1b[1m')
  })
})

describe('formatDuration', () => {
  it('uses ms below 1 second', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(7)).toBe('7ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('switches to s with two decimals at 1 second', () => {
    expect(formatDuration(1000)).toBe('1.00s')
    expect(formatDuration(1234)).toBe('1.23s')
    expect(formatDuration(60_000)).toBe('60.00s')
  })
})
