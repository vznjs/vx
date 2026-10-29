import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  flakyNote,
  formatTaskAbortedLine,
  formatTaskExecutedLine,
} from '../src/report/framed-output.js'
import { formatOutcomeTable, formatRunSummary } from '../src/report/summary.js'
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
  it('a run of every project paints no escape pair around an empty remainder', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: true },
      {
        version: '1.2.3',
        packageCount: 2,
        workspaceProjectCount: 2,
        remoteCacheEnabled: false,
      },
    )
    // eslint-disable-next-line no-control-regex -- ESC is the point
    expect(lines.filter((l) => /\x1b\[[0-9;]*m\x1b\[0m/.test(l))).toEqual([])
  })

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
        runId: '01a14941-c8cf-7a3e-9b51-2f06d4e8c713',
      },
    )
    expect(lines[1]).toBe('─ vx 1.2.3 ' + '─'.repeat(51))
    expect(lines).toContain(
      '  info      8 workers · local + remote cache · run 01a14941-c8cf-7a3e-9b51-2f06d4e8c713',
    )
  })

  it("counts the run's distinct warnings on a warn row above info", () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: false },
      {
        version: '1.2.3',
        packageCount: 1,
        remoteCacheEnabled: true,
        warnings: () => [
          '\x1b[31m[vx] remote cache: upload a1 failed: HTTP 403\x1b[0m',
          '[vx] remote cache: upload a1 failed: HTTP 403',
          'second\nwith a second line',
          '',
        ],
      },
    )
    const at = lines.findIndex((l) => l.startsWith('  warn'))
    expect(lines.slice(at, at + 2)).toEqual([
      '  warn      2 warnings above',
      expect.stringMatching(/^ {2}info/),
    ])
  })

  it('has no warn row when nothing warned', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: false },
      {
        version: '1.2.3',
        packageCount: 1,
        remoteCacheEnabled: false,
        warnings: () => [],
      },
    )
    expect(lines.some((l) => l.startsWith('  warn'))).toBe(false)
  })

  it('names the cache scope after the cache mode when the run has one', () => {
    const lines = formatRunSummary(
      [outcome('a#x', 'success')],
      10,
      { enabled: false },
      {
        version: '1.2.3',
        packageCount: 1,
        concurrency: 2,
        remoteCacheEnabled: true,
        cacheScope: 'ref-feat/x',
        workspaceProjectCount: 1,
      },
    )
    expect(lines).toContain('  info      2 workers · local + remote cache · scope ref-feat/x')
  })

  it('names on the info row only the layers the run used', () => {
    const info = (layers: { local: boolean; remote: boolean }): string | undefined =>
      formatRunSummary(
        [outcome('a#x', 'success')],
        10,
        { enabled: false },
        {
          version: '0.0.0',
          packageCount: 1,
          remoteCacheEnabled: true,
          cache: {
            ...layers,
            localWrite: layers.local,
            traffic: { inFlight: 0, keys: new Map() },
            notDownloaded: () => 0,
          },
        },
      ).find((l) => l.startsWith('  info'))
    expect(info({ local: true, remote: true })).toBe('  info      local + remote cache')
    expect(info({ local: true, remote: false })).toBe('  info      local cache')
    expect(info({ local: false, remote: true })).toBe('  info      remote cache')
    // --no-cache with a remote declared said `local + remote cache`.
    expect(info({ local: false, remote: false })).toBe('  info      no cache')
  })

  describe('the cache legend reads per layer: ✓ fresh, ↓ restored, ↑ saved, ✗ failed, ⇡ uploading (2026-10-15)', () => {
    const cached = (
      id: string,
      status: TaskOutcome['status'],
      extra: Partial<TaskOutcome> = {},
    ): TaskOutcome => ({
      ...outcome(id, status),
      node: { id, config: { exec: { command: 'noop' }, cache: {} } } as unknown as TaskNode,
      hash: `h-${id}`,
      ...extra,
    })
    const run = [
      cached('a#build', 'success', { saved: true }),
      cached('b#build', 'success', { saved: true }),
      cached('c#build', 'success'),
      cached('d#build', 'cache-hit-remote', { restored: true }),
      cached('e#build', 'cache-hit-remote', { restored: false }),
      cached('f#build', 'cache-hit', { restored: true }),
      cached('g#build', 'cache-hit', { restored: false }),
      outcome('h#dev', 'success'),
    ]
    type Traffic = Record<string, { uploading?: number; failures?: string[] }>
    const trafficOf = (t: Traffic) => {
      const keys = new Map(
        Object.entries(t).map(([id, k]) => [
          `h-${id}`,
          { uploading: k.uploading ?? 0, failures: k.failures ?? [] },
        ]),
      )
      let inFlight = 0
      for (const k of keys.values()) inFlight += k.uploading
      return { inFlight, keys }
    }
    const footer = (
      layers: { local?: boolean; localWrite?: boolean; remote?: boolean },
      traffic: Traffic = { 'a#build': {}, 'b#build': {} },
      notDownloaded = 0,
      colors = { enabled: false },
    ): string[] =>
      formatRunSummary(run, 10, colors, {
        version: '0.0.0',
        packageCount: 1,
        remoteCacheEnabled: layers.remote !== false,
        cache: {
          local: layers.local ?? true,
          localWrite: layers.localWrite ?? true,
          remote: layers.remote ?? true,
          traffic: trafficOf(traffic),
          notDownloaded: () => notDownloaded,
        },
      })
    const legend = (...args: Parameters<typeof footer>): string => {
      const lines = footer(...args)
      return lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()
    }

    it('each task counts once: an upload that landed moves a saved task to remote ↑', () => {
      expect(legend({})).toBe('local 2✓ 1∅ 1↓ · remote 1↓ 2↑ · 1 not saved')
      expect(legend({}, {})).toBe('local 2✓ 1∅ 1↓ 2↑ · remote 1↓ · 1 not saved')
    })

    it('a failed read or write is one ✗ count; ⇡ is an upload still running, last', () => {
      const traffic = {
        'a#build': { failures: ['upload: 503'] },
        'b#build': { uploading: 1 },
        'd#build': { failures: ['download: connection refused'] },
      }
      expect(legend({}, traffic, 3)).toBe(
        'local 2✓ 1∅ 1↓ · remote 2✗ 1⇡ · 1 not saved · 3 not downloaded',
      )
    })

    it('a failure outranks an upload still running on another remote', () => {
      expect(legend({}, { 'a#build': { uploading: 1, failures: ['upload: 500'] } })).toBe(
        'local 2✓ 1∅ 1↓ 1↑ · remote 1↓ 1✗ · 1 not saved',
      )
    })

    it('a task still running is not counted until it ends', () => {
      expect(legend({}, { 'z#build': { uploading: 1 } })).toBe(
        'local 2✓ 1∅ 1↓ 2↑ · remote 1↓ · 1 not saved',
      )
    })

    it('a layer the run did not use is not shown', () => {
      expect(legend({ remote: false }, {})).toBe('local 2✓ 1∅ 1↓ 2↑ · 1 not saved')
    })

    it('local ↑ shows only when the policy writes the local layer', () => {
      expect(legend({ localWrite: false }, {})).toBe('local 2✓ 1∅ 1↓ · remote 1↓ · 1 not saved')
    })

    it('the bar has a segment per state, each legend count painted in its colour', () => {
      const traffic = {
        'a#build': { failures: ['upload: 503'] },
        'b#build': { uploading: 1 },
      }
      const lines = footer({}, traffic, 0, { enabled: true })
      const at = lines.findIndex((l) => l.includes('cache'))
      const rgb = (hex: string) => Bun.color(hex, 'ansi-16m')!
      // A run of cells per segment, in bar order: the colour, then how many.
      const cell = new RegExp(`((?:${'\x1b'}\\[[0-9;]*m)+)(▰+)`, 'g')
      const runs = [...lines[at]!.matchAll(cell)].map((m) => [
        m[1]!.replaceAll('\x1b[0m', ''),
        m[2]!.length,
      ])
      const RED = rgb('#ef4444')
      const GREEN = rgb('#22c55e')
      const SKY = rgb('#38bdf8')
      const BLUE = rgb('#2563eb')
      const CYAN = rgb('#06b6d4')
      const YELLOW = rgb('#eab308')
      // c not saved · h no cache · e g fresh · f local ↓ · d remote ↓ · b ⇡ · a ✗
      expect(runs.map(([c]) => c)).toEqual([YELLOW, '\x1b[2m', GREEN, SKY, BLUE, CYAN, RED])
      expect(runs.map(([, n]) => n)).toEqual([7, 6, 13, 6, 6, 6, 6])
      const legendLine = lines[at + 1]!
      expect(legendLine).toContain(`${GREEN}2✓`)
      expect(legendLine).toContain(`\x1b[2m1∅`)
      expect(legendLine).toContain(`${SKY}1↓`)
      expect(legendLine).toContain(`${BLUE}1↓`)
      expect(legendLine).toContain(`${RED}1✗`)
      expect(legendLine).toContain(`${CYAN}1⇡`)
      expect(legendLine).toContain(`${YELLOW}1 not saved`)
      // The layer words are dim, never a layer colour (2026-10-15).
      expect(legendLine).toContain('\x1b[2mlocal\x1b[0m')
      expect(legendLine).toContain('\x1b[2mremote\x1b[0m')
    })

    // 2026-10-21: a red cell with no count under it.
    it('a miss that was not saved for failing is a red count of its own', () => {
      const lines = formatRunSummary(
        [cached('a#build', 'success', { saved: true }), cached('b#build', 'failed')],
        10,
        { enabled: false },
        {
          version: '0.0.0',
          packageCount: 1,
          remoteCacheEnabled: false,
          cache: {
            local: true,
            localWrite: true,
            remote: false,
            traffic: trafficOf({}),
            notDownloaded: () => 0,
          },
        },
      )
      expect(lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()).toBe(
        'local 1↑ · 1 miss',
      )
    })

    // CI, 2026-10-21: a task not saved here whose bytes went to the remote
    // left its bucket twice, and the bar's repeat threw on a negative count.
    it('a task not saved here that uploaded leaves the not-saved count once', () => {
      const lines = formatRunSummary(
        [cached('a#build', 'success'), cached('b#build', 'success', { saved: true })],
        10,
        { enabled: false },
        {
          version: '0.0.0',
          packageCount: 1,
          remoteCacheEnabled: true,
          cache: {
            local: true,
            localWrite: true,
            remote: true,
            traffic: trafficOf({ 'a#build': {}, 'b#build': {} }),
            notDownloaded: () => 0,
          },
        },
      )
      expect(lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()).toBe('remote 2↑')
    })

    // On CI a failed task's read failed under its key, and its kept log
    // (`cache.upload.failures`) landed under its id. Moved once per key,
    // its miss went to -1 and the bar threw.
    it('a task with traffic under both its key and its id counts once', () => {
      const keys = new Map([
        ['h-a#build', { uploading: 0, failures: ['download: connection refused'] }],
        ['a#build', { uploading: 0, failures: [] }],
      ])
      const lines = formatRunSummary(
        [cached('a#build', 'failed')],
        10,
        { enabled: false },
        {
          version: '0.0.0',
          packageCount: 1,
          remoteCacheEnabled: true,
          cache: {
            local: true,
            localWrite: true,
            remote: true,
            traffic: { inFlight: 0, keys },
            notDownloaded: () => 0,
          },
        },
      )
      expect(lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()).toBe('remote 1✗')
    })

    it('CONTROL: with no run context the legend is the plain one', () => {
      const lines = formatRunSummary(run, 10)
      expect(lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()).toBe(
        '3 miss · 1 no-cache · 2 up-to-date · 1 local · 1 remote',
      )
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

  it("an executor's own rows sit above the info row, which then names no pool", () => {
    const ctx = {
      version: '0.0.0',
      packageCount: 1,
      remoteCacheEnabled: false,
      concurrency: 4,
      executorRows: () =>
        [
          ['workers', '1 online'],
          ['', 'small#1  1 ran'],
        ] as const,
    }
    const lines = formatRunSummary([outcome('a#x', 'success')], 10, { enabled: false }, ctx)
    const at = lines.findIndex((l) => l.startsWith('  workers'))
    expect(lines.slice(at - 1, at + 4)).toEqual([
      '',
      '  workers   1 online',
      '            small#1  1 ran',
      '',
      '  info      local cache',
    ])
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

  it('ends on the time row; no result row repeats the rest', () => {
    const ctx = { version: '0.0.0', packageCount: 1, remoteCacheEnabled: false }
    const last = (outcomes: TaskOutcome[], ms: number): string | undefined =>
      formatRunSummary(outcomes, ms, { enabled: false }, ctx).at(-1)
    // A hit's stored exec time is not said: summed, it overstated the wall
    // time hits would have taken side by side (2026-10-18).
    const hit: TaskOutcome = {
      ...outcome('a#x', 'cache-hit'),
      durationMs: 2,
      storedDurationMs: 2010,
    }
    expect(last([hit, outcome('c#x', 'success')], 90)).toBe('  time      90ms')
    // The wall time is said once (2026-10-14).
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

  // 2026-10-14: every task in the run counts toward the total, each
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
      ' ✗   100ms                 aborted                                       local        a#t',
    )
    expect(formatTaskAbortedLine(node('a#after'), outcome('a#after', 'aborted', 1))).toBe(
      ' ◌                         not run                                                    a#after',
    )
  })

  it('a run with nothing aborted reads as before', () => {
    expect(formatRunSummary([outcome('a#x', 'success')], 10)[3]).toBe(
      '            1 success · 1 total',
    )
  })
})

describe('a flaky task says so on its own row', () => {
  // Nothing prints below the footer (2026-10-06): the Flaky section
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
    ).toBe(
      ' ⏺︎   100ms                 success miss                                  local        a#x',
    )
  })

  it('the note rides the row, dim', () => {
    const o = flaky('solid-js#types', 'success', 1, 1)
    expect(formatTaskExecutedLine(o.node, o)).toBe(
      ' ⏺︎   100ms                 success miss                                  local        solid-js#types flaky - failed 1× before',
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
    // A cached task (a `cache` block) that ran and saved: the page's "local 4↑" row.
    const timed = (id: string, durationMs: number): TaskOutcome => ({
      ...outcome(id, 'success'),
      node: { id, config: { exec: { command: 'noop' }, cache: {} } } as TaskNode,
      durationMs,
      saved: true,
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
        runId: '01a14941-c8cf-7a3e-9b51-2f06d4e8c713',
        cache: {
          local: true,
          localWrite: true,
          remote: false,
          traffic: { inFlight: 0, keys: new Map() },
          notDownloaded: () => 0,
        },
      },
    )
    // The leading blank line stands the footer apart from the last frame;
    // the page's block starts at the rule.
    expect(block![1]).toBe(lines.join('\n').replace(/^\n/, '') + '\n')
  })
})

// 2026-10-14: the footer never says a fact twice. `result` only
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

  it('the time row says only the wall time', () => {
    expect(footers['all hits']!.at(-1)).toBe('  time      10ms')
  })
})

// 2026-10-14: on every footer line with a total, the total comes last.
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

describe('formatOutcomeTable', () => {
  const node = (id: string) => {
    const [projectName, taskName] = id.split('#') as [string, string]
    return { id, projectName, taskName, config: { exec: { command: 'noop' } } } as TaskNode
  }
  const rows: TaskOutcome[] = [
    { node: node('a#build'), status: 'success', exitCode: 0, durationMs: 12 },
    { node: node('a#test'), status: 'failed', exitCode: 3, durationMs: 40 },
    { node: node('b#test'), status: 'skipped', exitCode: 0, durationMs: 0, blockedBy: 'a#test' },
  ]

  it('paints on a colour terminal: no line of it is plain text', () => {
    const lines = formatOutcomeTable(rows, { enabled: true })
    for (const l of lines.filter((x) => x !== '')) expect(l).toContain('\x1b[')
    const failed = lines.find((l) => Bun.stripANSI(l).startsWith('a#test'))!
    expect(failed).toContain(Bun.color('#ef4444', 'ansi-16m')!)
    const skipped = lines.find((l) => Bun.stripANSI(l).startsWith('b#test'))!
    expect(skipped).toContain(Bun.color('#eab308', 'ansi-16m')!)
  })

  it('keeps its columns: painted and plain read the same once stripped', () => {
    const plain = formatOutcomeTable(rows)
    expect(formatOutcomeTable(rows, { enabled: true }).map((l) => Bun.stripANSI(l))).toEqual(plain)
    expect(plain.join('\n')).not.toContain('\x1b')
  })

  it('names a task the stop reached before it ran `not run`, as its row and the footer do', () => {
    const killed: TaskOutcome = { ...outcome('a#x', 'aborted', 130), wallclockStartNs: 1n }
    const lines = formatOutcomeTable([killed, outcome('b#x', 'aborted', 1)])
    expect(lines.slice(3).map((l) => l.split(/\s{2,}/)[1])).toEqual(['aborted', 'not run'])
  })
})
