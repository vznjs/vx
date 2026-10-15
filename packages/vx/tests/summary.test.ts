import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  flakyNote,
  formatTaskAbortedLine,
  formatTaskExecutedLine,
} from '../src/orchestrator/framed-output.js'
import { formatRunSummary } from '../src/orchestrator/summary.js'
import { formatElapsed } from '../src/util/index.js'
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
      '─ vx ' + '─'.repeat(57),
      '  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      '            2 success · 2 total',
      '  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      '            2 no-cache',
      '',
      '  time      1.23s',
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
    expect(lines[3]).toBe('            3 success · 3 total')
    expect(lines[5]).toBe('            1 no-cache · 2 up-to-date')
    expect(lines.at(-1)).toBe('  time      420ms')
  })

  it('reports failures separately from total', () => {
    const lines = formatRunSummary(
      [outcome('a#test', 'success'), outcome('b#test', 'failed', 1)],
      850,
    )
    expect(lines[3]).toBe('            1 failed · 1 success · 2 total')
    expect(lines[5]).toBe('            2 no-cache')
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
    expect(lines[3]).toBe('            1 failed · 1 success · 1 skipped · 3 total')
  })

  it('treats cache-hit-remote as successful', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit-remote')], 10)
    expect(lines[3]).toBe('            1 success · 1 total')
    expect(lines[5]).toBe('            1 up-to-date')
  })

  // The ⚡ instant stamp was removed by owner decision — full-cache
  // runs read from the full meter bar instead.
  it('full-cache run: plain time row (spread counts misses only), full meter bar', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'cache-hit'), outcome('b#x', 'cache-hit-remote')],
      42,
    )
    expect(lines.at(-1)).toBe('  time      42ms')
  })

  it('partial-cache run: one executed task has no spread to show', () => {
    const lines = formatRunSummary([outcome('a#x', 'cache-hit'), outcome('b#x', 'success')], 42)
    expect(lines.at(-1)).toBe('  time      42ms')
  })

  it('empty run: 0 tasks row, no cache row', () => {
    const lines = formatRunSummary([], 0)
    expect(lines.at(-1)).toBe('  time      0ms')
    expect(lines.find((l) => l.includes('from cache'))).toBeUndefined()
  })

  it('a run of command-less groups says why it ran 0 tasks', () => {
    const group = (id: string): TaskOutcome => {
      const [projectName, taskName] = id.split('#')
      return {
        node: { id, projectName, taskName, config: {} } as TaskNode,
        status: 'success',
        exitCode: 0,
        durationMs: 0,
      }
    }
    expect(formatRunSummary([group('a#build'), group('b#build')], 0)[2]).toBe(
      '  tasks     0 tasks · build has no command in these projects',
    )
    expect(formatRunSummary([group('a#build'), group('a#check')], 0)[2]).toBe(
      '  tasks     0 tasks · build, check have no command in these projects',
    )
    // Control: a run with one command task is not a run of groups.
    expect(
      formatRunSummary([group('a#build'), outcome('a#x', 'aborted', 130)], 0)[2],
    ).not.toContain('no command')
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

  it('folds run context into the footer: version on the rule + info row', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success'), outcome('b#x', 'success')],
      1234,
      { enabled: false },
      {
        version: '1.2.3',
        packageCount: 5,
        concurrency: 8,
        remoteCacheEnabled: true,
        workspaceProjectCount: 12,
      },
    )
    expect(lines[1]).toBe('─ vx 1.2.3 ' + '─'.repeat(51))
    expect(lines).toContain('  info      8 workers · local + remote cache')
  })

  describe('a remote cache splits the misses by layer and counts uploads (M, 2026-10-15)', () => {
    const cached = (
      id: string,
      status: TaskOutcome['status'],
      restored?: boolean,
    ): TaskOutcome => ({
      ...outcome(id, status),
      node: { id, config: { exec: { command: 'noop' }, cache: {} } } as unknown as TaskNode,
      ...(restored !== undefined ? { restored } : {}),
    })
    const run = [
      cached('a#build', 'success'),
      cached('b#build', 'success'),
      cached('c#build', 'cache-hit-remote', true),
      cached('d#build', 'cache-hit-remote', false),
      cached('e#build', 'cache-hit', true),
      outcome('f#dev', 'success'),
    ]
    const legend = (cache?: {
      localRead: boolean
      remoteRead: boolean
      remoteWrite: boolean
      uploads: { count: number; failed: number }
    }): string => {
      const ctx = {
        version: '0.0.0',
        packageCount: 1,
        remoteCacheEnabled: cache !== undefined,
        ...(cache !== undefined ? { cache } : {}),
      }
      const lines = formatRunSummary(run, 10, { enabled: false }, ctx)
      return lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()
    }

    it('a remote hit was a local miss; a task that ran missed both', () => {
      expect(
        legend({
          localRead: true,
          remoteRead: true,
          remoteWrite: true,
          uploads: { count: 2, failed: 0 },
        }),
      ).toBe(
        '4 local miss · 2 remote miss · 2 uploaded · 1 no-cache · 1 up-to-date · 1 local hit · 1 remote hit',
      )
    })

    it('a failed upload is counted apart', () => {
      expect(
        legend({
          localRead: true,
          remoteRead: true,
          remoteWrite: true,
          uploads: { count: 1, failed: 1 },
        }),
      ).toContain('2 remote miss · 1 uploaded · 1 upload failed ·')
    })

    it('a read-only remote uploads nothing and says nothing of uploads', () => {
      expect(
        legend({
          localRead: true,
          remoteRead: true,
          remoteWrite: false,
          uploads: { count: 0, failed: 0 },
        }),
      ).toStartWith('4 local miss · 2 remote miss · 1 no-cache')
    })

    it('a write-only remote was never asked, so a miss is the local one', () => {
      expect(
        legend({
          localRead: true,
          remoteRead: false,
          remoteWrite: true,
          uploads: { count: 2, failed: 0 },
        }),
      ).toStartWith('2 miss · 2 uploaded · 1 no-cache')
    })

    it('a local layer the policy skips counts no local miss', () => {
      expect(
        legend({
          localRead: false,
          remoteRead: true,
          remoteWrite: true,
          uploads: { count: 2, failed: 0 },
        }),
      ).toStartWith('2 remote miss · 2 uploaded')
    })

    it('CONTROL: no remote keeps one miss count', () => {
      expect(legend()).toStartWith('2 miss · 1 no-cache')
    })
  })

  it('the info row sums what an admit policy held; no hold, no words', () => {
    const ctx = { version: '0.0.0', packageCount: 1, remoteCacheEnabled: false, concurrency: 4 }
    const held = { ...outcome('a#x', 'success'), admissionHeldMs: 1200 }
    const lines = formatRunSummary([held, outcome('b#x', 'success')], 10, { enabled: false }, ctx)
    const info = lines.find((l) => l.startsWith('  info'))!
    expect(info).toBe('  info      4 workers · local cache · admit held 1 task, 1.20s in all')
    const plain = formatRunSummary([outcome('a#x', 'success')], 10, { enabled: false }, ctx)
    expect(plain.find((l) => l.startsWith('  info'))).toBe('  info      4 workers · local cache')
  })

  it('leads with the projects bar (affected vs workspace total)', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: false },
      {
        version: '0.0.0',
        packageCount: 1,
        remoteCacheEnabled: false,
        workspaceProjectCount: 4,
      },
    )
    expect(lines[2]).toBe('  projects  ' + '▰'.repeat(13) + '▱'.repeat(37))
    expect(lines[3]).toBe('            1 affected · 4 total')
    // local-only mode reads on the info row (no worker count here)
    expect(lines).toContain('  info      local cache')
  })

  it('no context keeps a bare `vx` rule and no projects/info rows (live-region parity)', () => {
    const lines = formatRunSummary([outcome('a#x', 'success')], 10)
    expect(lines[1]).toBe('─ vx ' + '─'.repeat(57))
    expect(lines.find((l) => l.startsWith('  projects'))).toBeUndefined()
    expect(lines.find((l) => l.startsWith('  info'))).toBeUndefined()
    expect(lines.find((l) => l.startsWith('  result'))).toBeUndefined()
  })

  it('ends on the time row, which carries what the cache saved; no result row repeats the rest', () => {
    const ctx = { version: '0.0.0', packageCount: 1, remoteCacheEnabled: false }
    const last = (outcomes: TaskOutcome[], ms: number): string | undefined =>
      formatRunSummary(outcomes, ms, { enabled: false }, ctx).at(-1)
    // A hit says what it saved: its STORED exec time, not the restore.
    const hit = (id: string, storedDurationMs: number): TaskOutcome => ({
      ...outcome(id, 'cache-hit'),
      durationMs: 2,
      storedDurationMs,
    })
    expect(last([hit('a#x', 2010), hit('b#x', 300), outcome('c#x', 'success')], 90)).toBe(
      '  time      90ms · 2.31s saved',
    )
    // Nothing saved under a millisecond is said.
    expect(last([outcome('a#x', 'success')], 37)).toBe('  time      37ms')
    // The wall time is said once (M, 2026-10-14).
    const footer = formatRunSummary([outcome('a#x', 'cache-hit')], 4321, { enabled: false }, ctx)
    expect(footer.filter((l) => l.includes('4.32s'))).toEqual(['  time      4.32s'])
    for (const run of [[], [outcome('a#x', 'failed', 1)]])
      expect(
        formatRunSummary(run, 5, { enabled: false }, ctx).some((l) => l.includes('result')),
      ).toBe(false)
  })
})

describe('formatElapsed', () => {
  it('uses ms below 1 second', () => {
    expect(formatElapsed(0)).toBe('0ms')
    expect(formatElapsed(7)).toBe('7ms')
    expect(formatElapsed(999)).toBe('999ms')
  })

  it('switches to s with two decimals at 1 second', () => {
    expect(formatElapsed(1000)).toBe('1.00s')
    expect(formatElapsed(1234)).toBe('1.23s')
    expect(formatElapsed(60_000)).toBe('60.00s')
  })

  it('ROUNDS sub-second, never truncates', () => {
    // A 1.6 ms task that reads as `1ms` understates every short task in
    // the run, and the rows they sit in are compared against each other.
    expect(formatElapsed(1.6)).toBe('2ms')
    expect(formatElapsed(0.4)).toBe('0ms')
  })
})

describe('aborted and not-run tasks', () => {
  // Since M-83 they are rows in the task list; the footer names them outside
  // `total`, which history and telemetry share. A killed task carries a
  // wall-clock start; one the stop reached first does not (item 1062).
  const killed = (id: string, exitCode = 130): TaskOutcome => ({
    ...outcome(id, 'aborted', exitCode),
    wallclockStartNs: 1_000n,
  })
  const group: TaskOutcome = {
    node: { id: 'a#all', config: {} } as TaskNode,
    status: 'aborted',
    exitCode: 1,
    durationMs: 0,
  }
  const run = [
    killed('a#t'),
    outcome('a#after', 'aborted', 1),
    outcome('a#lint', 'aborted', 1),
    group,
    outcome('b#x', 'success'),
  ]

  // M, 2026-10-14: every task in the run counts toward the total, each
  // state its own segment of the bar; no "not counted".
  it('the tasks legend counts each in the total, a group in neither', () => {
    const ctx = { version: '0.0.0', packageCount: 1, remoteCacheEnabled: false }
    const lines = formatRunSummary(run, 10, { enabled: false }, ctx)
    expect(lines[3]).toBe('            1 success · 1 aborted · 2 not run · 4 total')
    expect(lines.at(-1)).toBe('  time      10ms')
  })

  it('a stop before any task finished fills the bar with what it took down', () => {
    const lines = formatRunSummary([killed('a#t')], 10)
    expect(lines[2]).toBe(`  tasks     ${'\u25b0'.repeat(50)}`)
    expect(lines[3]).toBe('            1 aborted · 1 total')
  })

  it('failed, aborted and not run are each a visibly distinct segment', () => {
    const lines = formatRunSummary(
      [
        outcome('a#x', 'failed', 1),
        killed('b#x'),
        outcome('c#x', 'aborted', 1),
        outcome('d#x', 'success'),
      ],
      10,
      { enabled: true },
    )
    const bar = lines.find((l) => l.includes('tasks'))!
    // Each segment opens its own colour: four states, four paints.
    // eslint-disable-next-line no-control-regex -- the colour escapes are the point
    const paints = [...bar.matchAll(/\x1b\[([0-9;]*)m\u25b0/g)].map((m) => m[1])
    expect(new Set(paints).size).toBe(4)
  })

  it('the rows: `aborted` with its time, `not run` with none, cache blank', () => {
    const node = (id: string): TaskNode => {
      const [projectName, taskName] = id.split('#')
      return { id, projectName, taskName, config: { exec: { command: 'noop' } } } as TaskNode
    }
    expect(formatTaskAbortedLine(node('a#t'), killed('a#t'))).toBe(
      ' ✗   100ms aborted          a#t',
    )
    expect(formatTaskAbortedLine(node('a#after'), outcome('a#after', 'aborted', 1))).toBe(
      ' ◌         not run          a#after',
    )
  })

  it('a run with nothing aborted reads as before', () => {
    expect(formatRunSummary([outcome('a#x', 'success')], 10)[3]).toBe(
      '            1 success · 1 total',
    )
  })
})

describe('a flaky task says so on its own row', () => {
  // Nothing prints below the footer (owner, 2026-10-06): the Flaky section
  // under it became a dim note on the task's row and frame.
  const node = (id: string): TaskNode => {
    const [projectName, taskName] = id.split('#') as [string, string]
    return {
      id,
      projectName,
      taskName,
      config: { exec: { command: 'noop' }, cache: {} },
    } as TaskNode
  }
  const flaky = (
    id: string,
    status: 'success' | 'failed',
    passes: number,
    failures: number,
    attempts?: number,
  ): TaskOutcome => ({
    ...outcome(id, status, status === 'failed' ? 1 : 0),
    node: node(id),
    flaky: { passes, failures },
    ...(attempts !== undefined && { attempts }),
  })

  it('a pass names the failures before it, a failure the passes, a retry its attempts', () => {
    expect(flakyNote(flaky('a#types', 'success', 1, 1))).toBe(' flaky - failed 1× before')
    expect(flakyNote(flaky('a#test', 'failed', 3, 1))).toBe(' flaky - passed 3× before')
    expect(flakyNote(flaky('a#e2e', 'success', 1, 2, 2))).toBe(
      ' flaky - failed 2× before · 2 attempts',
    )
    expect(flakyNote(flaky('a#lint', 'success', 1, 0, 2))).toBe(' flaky - 2 attempts')
  })

  it('a task the run did not prove flaky carries nothing', () => {
    expect(flakyNote(outcome('a#x', 'success'))).toBe('')
    expect(
      formatTaskExecutedLine(node('a#x'), { ...outcome('a#x', 'success'), node: node('a#x') }),
    ).toBe(' ⏺︎   100ms success miss     a#x')
  })

  it('the note rides the row, dim', () => {
    const o = flaky('solid-js#types', 'success', 1, 1)
    expect(formatTaskExecutedLine(o.node, o)).toBe(
      ' ⏺︎   100ms success miss     solid-js#types flaky - failed 1× before',
    )
    const colored = formatTaskExecutedLine(o.node, o, { enabled: true })
    expect(colored).toContain('\x1b[2mflaky - failed 1× before')
  })
})

describe('docs/modules/summary.md shows what the footer prints', () => {
  it('its Format block is formatRunSummary on four successes with the run context it names', () => {
    const doc = readFileSync(
      path.resolve(import.meta.dir, '..', 'docs', 'modules', 'summary.md'),
      'utf8',
    )
    const block = /## Format\n\n```\n([\s\S]*?)```/.exec(doc)
    expect(block).not.toBeNull()
    // A cached task (a `cache` block) that ran: the page's "4 miss" row.
    const timed = (id: string, durationMs: number): TaskOutcome => ({
      ...outcome(id, 'success'),
      node: { id, config: { exec: { command: 'noop' }, cache: {} } } as TaskNode,
      durationMs,
    })
    const lines = formatRunSummary(
      [timed('a#build', 239), timed('a#test', 190), timed('a#lint', 215), timed('a#fmt', 216)],
      248,
      undefined,
      {
        version: '0.0.0',
        packageCount: 1,
        concurrency: 10,
        remoteCacheEnabled: false,
        workspaceProjectCount: 2,
      },
    )
    // The leading blank line stands the footer apart from the last frame;
    // the page's block starts at the rule.
    expect(block![1]).toBe(lines.join('\n').replace(/^\n/, '') + '\n')
  })
})

// M, 2026-10-14: the footer never says a fact twice. `result` only
// repeated the tasks, cache and time rows (its one new fact, saved, moved
// to `time`), skipped was counted on both legends, and one executed task
// read as its own max, avg and min.
describe('the footer never repeats a value or a count', () => {
  const ctx = {
    version: '0.0.0',
    packageCount: 3,
    workspaceProjectCount: 9,
    concurrency: 4,
    remoteCacheEnabled: false,
  }
  const cached = (id: string, status: TaskOutcome['status'], ms: number): TaskOutcome => {
    const o = outcome(id, status, status === 'failed' ? 1 : 0)
    return {
      ...o,
      durationMs: ms,
      ...(status.startsWith('cache-hit') ? { storedDurationMs: 21_290 } : {}),
      node: { ...o.node, config: { ...o.node.config, cache: {} } } as TaskNode,
    }
  }
  const facts = (lines: readonly string[]): string[] =>
    lines
      .flatMap((l) => l.replace(/[▰▱]/g, '').split(/·|,|:/))
      .map((p) => p.trim().replace(/^(projects|tasks|cache|info|time|result)\s+/, ''))
      .filter((p) => /^[~<]?\d/.test(p))
  const footers: Record<string, string[]> = {
    'all hits': formatRunSummary(
      ['a', 'b', 'c', 'd'].map((p) => cached(`${p}#x`, 'cache-hit', 3)),
      10,
      { enabled: false },
      ctx,
    ),
    'one executed task': formatRunSummary(
      [cached('a#x', 'success', 5200)],
      5340,
      { enabled: false },
      ctx,
    ),
    'a red run': formatRunSummary(
      [
        cached('a#x', 'failed', 700),
        cached('b#x', 'success', 1300),
        cached('c#x', 'success', 2100),
        cached('d#x', 'cache-hit', 4),
        outcome('e#x', 'skipped'),
        outcome('f#x', 'skipped'),
      ],
      2500,
      { enabled: false },
      ctx,
    ),
  }
  for (const [name, lines] of Object.entries(footers)) {
    it(`${name}: each fact once`, () => {
      const seen = facts(lines)
      expect(seen.length).toBeGreaterThan(2)
      expect(seen.filter((f, i) => seen.indexOf(f) !== i)).toEqual([])
      expect(lines.some((l) => l.startsWith('  result'))).toBe(false)
    })
  }

  it('saved rides the time row', () => {
    expect(footers['all hits']!.at(-1)).toBe('  time      10ms · 85.16s saved')
  })
})

// M, 2026-10-14: on every footer line with a total, the total comes last.
describe('a total is the last word on its line', () => {
  it('projects and tasks, with every kind of task in the run', () => {
    const ctx = {
      version: '0.0.0',
      packageCount: 2,
      workspaceProjectCount: 5,
      remoteCacheEnabled: false,
    }
    const lines = formatRunSummary(
      [
        outcome('a#x', 'failed', 1),
        outcome('b#x', 'success'),
        outcome('c#x', 'skipped'),
        { ...outcome('d#x', 'aborted', 1), durationMs: 50, startedAt: 1 } as TaskOutcome,
        outcome('e#x', 'aborted', 1),
      ],
      10,
      { enabled: false },
      ctx,
    )
    const withTotal = lines.filter((l) => / total\b/.test(l))
    expect(withTotal).toHaveLength(2)
    for (const l of withTotal) expect(l).toMatch(/· \d+ total$/)
    expect(withTotal[0]).toBe('            2 affected · 5 total')
  })
})
