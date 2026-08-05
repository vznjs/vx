// The GitHub Actions job-summary emitter: markdown shape (failures first,
// verdict line, truncation) and the never-fail append.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { appendGithubSummary, formatGithubSummary } from '../src/github-summary.js'

function summary(
  tasks: Partial<TaskTelemetry>[],
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord {
  const full = tasks.map(
    (t): TaskTelemetry => ({
      taskId: t.taskId ?? 'p#build',
      project: (t.taskId ?? 'p#build').split('#')[0]!,
      task: (t.taskId ?? 'p#build').split('#')[1]!,
      status: t.status ?? 'success',
      cacheSource: t.cacheSource ?? 'miss',
      exitCode: t.exitCode ?? 0,
      durationMs: t.durationMs ?? 1000,
      ...(t.attempts !== undefined ? { attempts: t.attempts } : {}),
      ...(t.verify !== undefined ? { verify: t.verify } : {}),
    }),
  )
  return {
    v: 2,
    run: {
      runId: 'r',
      vxVersion: '0',
      workspaceId: 'ws',
      workspaceName: 'w',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: null,
      commitSha: null,
      branch: null,
      defaultBranch: null,
      dirty: null,
      ci: true,
      ciProvider: 'github',
      host: null,
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: 0,
    endedAt: 1000,
    totalDurationMs: 1000,
    taskCount: full.length,
    failedCount: full.filter((t) => t.status === 'failed').length,
    hitCount: full.filter((t) => t.cacheSource === 'local' || t.cacheSource === 'remote').length,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: full.every((t) => t.status !== 'failed'),
    tasks: full,
    ...over,
  }
}

describe('formatGithubSummary', () => {
  it('leads with the verdict + stats and the command', () => {
    const md = formatGithubSummary(summary([{ taskId: 'a#build' }, { taskId: 'b#test' }]))
    expect(md).toContain('vx run — `vx run ci`')
    expect(md).toContain('✅ passed')
    expect(md).toContain('**2** tasks')
    expect(md).toContain('| Task | Status | Duration | Cache |')
    expect(md).toContain('`a#build`')
  })

  it('renders the dashboard deep link when a dashboardUrl is passed, else no link', () => {
    const s = summary([{ taskId: 'a#build' }])
    const linked = formatGithubSummary(s, {
      dashboardUrl: 'https://vx.corp.example/#/runs/run-1',
    })
    expect(linked).toContain(
      '[Open this run in the vx dashboard](https://vx.corp.example/#/runs/run-1)',
    )
    expect(formatGithubSummary(s)).not.toContain('vx dashboard')
  })

  it('orders failed tasks first and marks the failure with its exit code', () => {
    const md = formatGithubSummary(
      summary([
        { taskId: 'ok#build', status: 'success' },
        { taskId: 'bad#test', status: 'failed', exitCode: 2 },
      ]),
    )
    expect(md).toContain('❌ failed (exit 2)')
    // The failed row appears before the successful one.
    expect(md.indexOf('bad#test')).toBeLessThan(md.indexOf('ok#build'))
  })

  it('flags a task that only passed after a retry as flaky', () => {
    const md = formatGithubSummary(summary([{ taskId: 'ui#test', status: 'success', attempts: 3 }]))
    expect(md).toContain('⚠️ flaky (3 attempts)')
    // A single-attempt success is NOT flagged.
    const clean = formatGithubSummary(summary([{ taskId: 'ui#test', status: 'success' }]))
    expect(clean).not.toContain('flaky')
  })

  it('surfaces the --verify hermeticity verdict + names diverging outputs', () => {
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'web#bundle',
          status: 'success',
          verify: { kind: 'nondeterministic', changed: ['dist/app.js', 'dist/app.js.map'] },
        },
        { taskId: 'lib#build', status: 'success', verify: { kind: 'proven-deterministic' } },
      ]),
    )
    // Headline hermeticity line (warns because one task is non-deterministic).
    expect(md).toContain('⚠️ Hermeticity: **1** proven · **1** unsafe')
    // Per-row marker names the diverging outputs.
    expect(md).toContain('⚠️ non-deterministic (dist/app.js, dist/app.js.map)')
    expect(md).toContain('🔒 verified')
  })

  it('surfaces the Phase-2 (inputs) verdicts: undeclared-inputs flagged + counted unsafe', () => {
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'api#build',
          status: 'success',
          verify: { kind: 'undeclared-inputs', paths: ['src/generated/schema.ts'] },
        },
        { taskId: 'lib#build', status: 'success', verify: { kind: 'proven-complete' } },
      ]),
    )
    // The run failed BECAUSE of hermeticity — the summary must say so.
    expect(md).toContain('⚠️ Hermeticity: **1** proven · **1** unsafe')
    expect(md).toContain('⚠️ undeclared inputs (src/generated/schema.ts)')
    // proven-complete renders the same verified marker as proven-deterministic.
    expect(md).toContain('🔒 verified')
  })

  it('does not print a hermeticity line for a run without --verify', () => {
    const md = formatGithubSummary(summary([{ taskId: 'a#build', status: 'success' }]))
    expect(md).not.toContain('Hermeticity')
    expect(md).not.toContain('verified')
  })

  it('truncates a long diverging-output list in the status cell', () => {
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'web#bundle',
          status: 'success',
          verify: {
            kind: 'nondeterministic',
            changed: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
          },
        },
      ]),
    )
    expect(md).toContain('non-deterministic (a.js, b.js, c.js, +2 more)')
  })

  it('drops aborted tasks and renders cache provenance', () => {
    const md = formatGithubSummary(
      summary([
        { taskId: 'hit#build', status: 'cache-hit', cacheSource: 'local' },
        { taskId: 'gone#x', status: 'aborted' },
      ]),
    )
    expect(md).toContain('🟦 cache hit')
    expect(md).toContain('| local |')
    expect(md).not.toContain('gone#x')
  })

  it('truncates a very large task list with a note', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ taskId: `p#t${i}` }))
    const md = formatGithubSummary(summary(many))
    expect(md).toContain('more tasks not shown')
    expect((md.match(/\| `p#t/g) ?? []).length).toBe(100)
  })
})

describe('appendGithubSummary', () => {
  it('appends the summary to the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-gha-'))
    const file = path.join(dir, 'summary.md')
    try {
      await appendGithubSummary(file, summary([{ taskId: 'a#b' }]), () => {})
      expect(readFileSync(file, 'utf8')).toContain('`a#b`')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws on an unwritable path (warns instead)', async () => {
    const warnings: string[] = []
    await appendGithubSummary('/nonexistent-dir/summary.md', summary([]), (m) => warnings.push(m))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('github summary')
  })
})

describe('triage verdicts on failed rows', () => {
  const failedRun = () =>
    summary([
      { taskId: 'a#flap', status: 'failed', exitCode: 1 },
      { taskId: 'a#broken', status: 'failed', exitCode: 1 },
      { taskId: 'a#mine', status: 'failed', exitCode: 1 },
      { taskId: 'a#ok', status: 'success' },
    ])

  it('marks each failed row with its verdict; success rows never consult the map', () => {
    const triage = new Map([
      ['a#flap', { verdict: 'flaky' as const, sameKeySuccesses: 3, keyChanged: false }],
      ['a#broken', { verdict: 'pre-existing' as const, sameKeySuccesses: 0, keyChanged: false }],
      ['a#mine', { verdict: 'new-failure' as const, sameKeySuccesses: 0, keyChanged: true }],
      // A (nonsensical) verdict for a green task must not render.
      ['a#ok', { verdict: 'flaky' as const, sameKeySuccesses: 9, keyChanged: false }],
    ])
    const md = formatGithubSummary(failedRun(), { triage })
    expect(md).toContain('🎲 flaky — not this change (same key passed 3×)')
    expect(md).toContain('📌 already broken on the default branch')
    expect(md).toContain('🆕 new failure — this run changed its inputs')
    const okLine = md.split('\n').find((l) => l.includes('a#ok'))!
    expect(okLine).not.toContain('flaky')
  })

  it('a new failure without a key change renders the bare marker', () => {
    const triage = new Map([
      ['a#mine', { verdict: 'new-failure' as const, sameKeySuccesses: 0, keyChanged: null }],
    ])
    const md = formatGithubSummary(summary([{ taskId: 'a#mine', status: 'failed', exitCode: 1 }]), {
      triage,
    })
    expect(md).toContain('🆕 new failure')
    expect(md).not.toContain('changed its inputs')
  })

  it('no triage map renders byte-identically to before (additive)', () => {
    const plain = formatGithubSummary(failedRun())
    expect(plain).toContain('❌ failed (exit 1)')
    expect(plain).not.toContain('🎲')
    expect(plain).not.toContain('📌')
    expect(plain).not.toContain('🆕')
  })

  it('an unknown verdict off the wire renders a plain failed cell, never "undefined"', () => {
    // fetchTriage casts the response body unvalidated — a newer serve's future
    // verdict string must degrade cleanly.
    const out = formatGithubSummary(failedRun(), {
      triage: new Map([
        ['a#flap', { verdict: 'quarantined' as never, sameKeySuccesses: 0, keyChanged: null }],
      ]),
    })
    expect(out).toContain('❌ failed (exit 1)')
    expect(out).not.toContain('undefined')
  })
})

describe('the headline counts only work that happened', () => {
  /** The shape `--continue=deps-ok` produces: a leaf breaks, dependents skip. */
  const depsOkRedRun = () =>
    summary([
      { taskId: 'lib#build', status: 'failed', exitCode: 2 },
      { taskId: 'app#build', status: 'skipped', cacheSource: 'none' },
      { taskId: 'web#build', status: 'skipped', cacheSource: 'none' },
      { taskId: 'docs#build', status: 'skipped', cacheSource: 'none' },
      { taskId: 'utils#build', status: 'cache-hit', cacheSource: 'local' },
      { taskId: 'core#build', status: 'success' },
    ])

  it('does not count a skipped task as executed', () => {
    // `executed` used to be `taskCount - hitCount`, and taskCount is
    // tasks.length — so all three skips were reported as executed work. That
    // overstates most on a RED run, which is the one this summary exists for.
    const md = formatGithubSummary(depsOkRedRun())
    expect(md).toContain('**2** executed')
    expect(md).toContain('**3** skipped')
    expect(md).not.toContain('**5** executed')
  })

  it('agrees with the terminal about the same run', () => {
    // The whole defect was two surfaces describing one run differently. The
    // terminal's tally for this fixture is successful=2 failed=1 skipped=3.
    const md = formatGithubSummary(depsOkRedRun())
    const head = md.split('\n')[2]!
    expect(head).toContain('**6** tasks')
    expect(head).toContain('**1** failed')
    expect(head).toContain('**1** cache hits')
    expect(head).toContain('**2** executed')
    expect(head).toContain('**3** skipped')
  })

  it('names skipped/aborted only when non-zero — a clean run keeps its short head', () => {
    // Control: the fix must not append an always-zero bucket to every run.
    const md = formatGithubSummary(summary([{ taskId: 'a#build' }, { taskId: 'b#test' }]))
    expect(md).toContain('**2** executed')
    expect(md).not.toContain('skipped')
    expect(md).not.toContain('aborted')
  })

  it('excludes an aborted task from the total, matching the table that drops it', () => {
    // An aborted task was killed by a teardown signal, so it is work that did
    // not happen; core's tally puts it in no bucket and no total. The head used
    // to count it while the table below already dropped its row.
    const md = formatGithubSummary(
      summary([
        { taskId: 'a#build', status: 'success' },
        { taskId: 'gone#x', status: 'aborted', cacheSource: 'none' },
      ]),
    )
    expect(md).toContain('**1** tasks')
    expect(md).toContain('**1** aborted')
    expect(md).not.toContain('gone#x')
  })
})

describe('table cells survive the names the loader actually accepts', () => {
  /** Unescaped pipes only — a `\|` is a literal pipe inside one cell. */
  const columns = (row: string) => row.replace(/\\\|/g, '').split('|').length - 2

  it('a pipe in a task name does not shift the columns', () => {
    // Neither half of a taskId is charset-validated: task names are arbitrary
    // TS object keys and package names are checked only for truthiness.
    const md = formatGithubSummary(summary([{ taskId: 'pkg#a|b', status: 'failed', exitCode: 7 }]))
    const row = md.split('\n').find((l) => l.includes('pkg#a'))!
    expect(columns(row)).toBe(4)
    expect(row).toContain('❌ failed (exit 7)')
  })

  it('a newline in a task name cannot inject a second row', () => {
    // A name carrying a whole fabricated row: unescaped, the newline ends the
    // real row and the rest becomes a second one claiming success.
    const md = formatGithubSummary(
      summary([{ taskId: 'pkg#a\n| EVIL | ✅ success | 0ms | local' }]),
    )
    const rows = md.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('| ---'))
    // The header plus exactly one task row — the injected row does not exist.
    expect(rows).toHaveLength(2)
    expect(columns(rows[1]!)).toBe(4)
    expect(rows[1]).toContain('pkg#a \\| EVIL')
  })

  it('a pipe in a --verify output path does not shift the columns', () => {
    // These are real paths off disk, not config: `|` is a legal filename byte.
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'web#bundle',
          status: 'success',
          verify: { kind: 'nondeterministic', changed: ['dist/a|b.js'] },
        },
      ]),
    )
    const row = md.split('\n').find((l) => l.includes('web#bundle'))!
    expect(columns(row)).toBe(4)
    expect(row).toContain('dist/a\\|b.js')
  })

  it('leaves an ordinary task name untouched', () => {
    // Control: escaping must not mangle the overwhelmingly common case.
    const md = formatGithubSummary(summary([{ taskId: '@acme/ui#build' }]))
    expect(md).toContain('`@acme/ui#build`')
    expect(md).not.toContain('\\')
  })
})

describe('duration + status rendering', () => {
  const durationOf = (ms: number) => {
    const md = formatGithubSummary(summary([{ taskId: 'p#t', durationMs: ms }]))
    return md
      .split('\n')
      .find((l) => l.includes('p#t'))!
      .split('|')[3]!
      .trim()
  }

  it('carries a rounded-up remainder into the minutes', () => {
    // Rounding the remainder independently of the minutes produced `1m 60s`
    // for any duration whose leftover seconds rounded to a full minute.
    expect(durationOf(119_500)).toBe('2m 0s')
    expect(durationOf(119_999)).toBe('2m 0s')
    expect(durationOf(59_999)).toBe('1m 0s')
    expect(durationOf(3_599_600)).toBe('60m 0s')
  })

  it('leaves the sub-minute and exact-minute cases alone', () => {
    // Control: the carry must not disturb what already read correctly.
    expect(durationOf(60_000)).toBe('1m 0s')
    expect(durationOf(59_400)).toBe('59.4s')
    expect(durationOf(1500)).toBe('1.5s')
    expect(durationOf(999)).toBe('999ms')
  })

  it('a status outside the union names itself instead of reading as a failure', () => {
    // Unreachable in-process (the record is core-built and typed) — the point
    // is the direction: the old catch-all rendered a future TaskStatus as
    // `❌ failed (exit undefined)`, i.e. a red row for a task that did not fail.
    const md = formatGithubSummary(
      summary([
        { taskId: 'p#t', status: 'cache-hit-store' as never, exitCode: undefined as never },
      ]),
    )
    const row = md.split('\n').find((l) => l.includes('p#t'))!
    expect(row).toContain('cache-hit-store')
    expect(row).not.toContain('❌')
    expect(row).not.toContain('undefined')
  })
})
