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
      '─ vx ' + '─'.repeat(55),
      '  tasks   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      '          2 success',
      '  cache   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      '          2 miss',
      '',
      '  time    1.23s · max 100ms · avg 100ms · min 100ms',
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
    expect(lines[3]).toBe('          3 success')
    expect(lines[5]).toBe('          1 miss · 2 up-to-date')
    expect(lines.at(-1)).toBe('  time    420ms' + ' · max 100ms · avg 100ms · min 100ms')
  })

  it('reports failures separately from total', () => {
    const lines = formatRunSummary(
      [outcome('a#test', 'success'), outcome('b#test', 'failed', 1)],
      850,
    )
    expect(lines[3]).toBe('          1 failed · 1 success')
    expect(lines[5]).toBe('          2 miss')
  })

  it('never lists failed task ids — count lives in the legend (owner: can be hundreds)', () => {
    // Failures get full frames in the stream AND pinned ✗ lines in
    // the live region; a summary id list would explode on broad runs.
    const lines = formatRunSummary(
      [
        outcome('@app/web#build', 'failed', 1),
        outcome('@app/api#test', 'failed', 2),
        outcome('lib#build', 'success'),
      ],
      1234,
    )
    expect(lines.find((l) => l.includes('@app/web#build'))).toBeUndefined()
    expect(lines.find((l) => l.includes('failed  '))).toBeUndefined()
    expect(lines.find((l) => l.includes('2 failed'))).toBeDefined()
  })

  it('reports skipped count when present', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success'), outcome('b#x', 'failed', 2), outcome('c#x', 'skipped')],
      50,
    )
    expect(lines[3]).toBe('          1 failed · 1 success · 1 skipped')
  })

  it('treats cache-hit-remote as successful', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit-remote')], 10)
    expect(lines[3]).toBe('          1 success')
    expect(lines[5]).toBe('          1 up-to-date')
  })

  // The ⚡ instant stamp was removed by owner decision — full-cache
  // runs read from the full meter bar instead.
  it('full-cache run: plain time row (spread counts misses only), full meter bar', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'cache-hit'), outcome('b#x', 'cache-hit-remote')],
      42,
    )
    expect(lines.at(-1)).toBe('  time    42ms')
  })

  it('partial-cache run: plain time row', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit'), outcome('b#x', 'success')], 42)
    expect(lines.at(-1)).toBe('  time    42ms · max 100ms · avg 100ms · min 100ms')
  })

  it('empty run: 0 tasks row, no cache row', () => {
    const lines = formatRunSummary([], 0)
    expect(lines.at(-1)).toBe('  time    0ms')
    expect(lines.find((l) => l.includes('from cache'))).toBeUndefined()
  })

  it('injects ANSI escapes around counts + stamp when colors are enabled', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit'), outcome('b#x', 'failed', 1)], 42, {
      enabled: true,
    })
    // legend line colorized (sits below the tasks bar)
    expect(lines[3]).toContain('\x1b[')
    expect(lines[3]).toContain('1 success')
    expect(lines[3]).toContain('1 failed')
  })

  it('gradient rule injects color escapes when enabled', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit')], 10, { enabled: true })
    expect(lines[1]).toContain('\x1b[38;2;')
    expect(lines[1]).toContain('vx')
  })

  it('folds run context into the footer: version on the rule, run row + cache mode', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success'), outcome('b#x', 'success')],
      1234,
      {
        enabled: false,
      },
      {
        version: '1.2.3',
        tasks: ['build', 'test'],
        taskCount: 2,
        packageCount: 5,
        concurrency: 8,
        remoteCacheEnabled: true,
      },
    )
    expect(lines[1]).toBe('─ vx 1.2.3 ' + '─'.repeat(49))
    expect(lines).toContain(
      '  run     build, test · 5 projects · 2 tasks · 8 workers · local + remote cache',
    )
  })

  it('renders the affected-scope bar when a workspace total is given', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: false },
      {
        version: '0.0.0',
        tasks: ['lint'],
        taskCount: 1,
        packageCount: 1,
        remoteCacheEnabled: false,
        workspaceProjectCount: 4,
      },
    )
    expect(lines).toContain('  scope   ' + '▰'.repeat(13) + '▱'.repeat(37))
    expect(lines).toContain('          1 affected · 4 total')
    // local-only mode reads on the run row
    expect(lines.find((l) => l.includes('local cache'))).toBeDefined()
  })

  it('no context keeps a bare `vx` rule and no run row (live-region parity)', () => {
    const lines = formatRunSummary([outcome('a#x', 'success')], 10)
    expect(lines[1]).toBe('─ vx ' + '─'.repeat(55))
    expect(lines.find((l) => l.startsWith('  run '))).toBeUndefined()
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
