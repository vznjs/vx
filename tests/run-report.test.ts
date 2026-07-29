// Tests for `formatRunReportMarkdown` — the `--report=markdown` table.
//
// This string is the one MACHINE-READABLE artifact a CI job publishes about a
// run: the documented recipe is `vx run ci --report-file="$GITHUB_STEP_SUMMARY"`,
// so it becomes the summary a reviewer reads on the PR page when a build goes
// red. It had no dedicated test file — its coverage lived incidentally in the
// tally and CLI suites — and it has produced three separate defects, each of
// which was a WRONG NUMBER rather than a crash:
//
//   • it counted GROUP tasks, so this repo's own `ci`/`lint`/`build` umbrellas
//     rendered as rows claiming `success | miss | 0ms` and inflated the totals;
//   • its headline "N saved" summed what the cache SPENT (a hit's restore
//     cost), reporting a 2.01 s task as "4ms saved" — 500× understated, on the
//     single number a reader of a step summary cares about;
//   • cells were unescaped, so a task name containing `|` silently added a
//     column and a newline split the row.
//
// A wrong number in a green table is the failure mode here, so the assertions
// are on VALUES, not on the string merely being non-empty.

import { describe, expect, it } from 'bun:test'
import { formatRunReportMarkdown } from '../src/orchestrator/run-report.js'
import type { OutcomeView } from '../src/orchestrator/events.js'
import type { RunResult } from '../src/orchestrator/protocol.js'

function view(over: Partial<OutcomeView> & { taskId: string }): OutcomeView {
  return {
    status: 'success',
    exitCode: 0,
    durationMs: 100,
    ...over,
  } as OutcomeView
}

function report(outcomes: OutcomeView[], ok = true): string {
  return formatRunReportMarkdown({ ok, outcomes } as RunResult)
}

/** The `**N tasks** · …` headline, which is what a reviewer actually reads. */
function headline(md: string): string {
  return md.split('\n').find((l) => l.startsWith('**')) ?? ''
}

/** Data rows only — the two rows of table chrome dropped. */
function rows(md: string): string[] {
  return md
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| --- ') && !l.startsWith('| Task '))
}

describe('the headline totals', () => {
  it('reports a passing run with its buckets', () => {
    const md = report([
      view({ taskId: 'a#build' }),
      view({ taskId: 'a#test' }),
      view({ taskId: 'b#build', status: 'cache-hit', storedDurationMs: 2000, durationMs: 4 }),
    ])
    // The two counts partition the SAME run along different axes, and reading
    // them as one list is the easy mistake: `success` says how each task
    // ENDED, so a cache hit is a success; `cached` says where the result CAME
    // from. They deliberately overlap — 3 success of which 1 was cached — and
    // do not sum to the total.
    expect(md).toContain('## vx run — passed')
    expect(headline(md)).toContain('**3 tasks**')
    expect(headline(md)).toContain('3 success')
    expect(headline(md)).toContain('0 failed')
    expect(headline(md)).toContain('1 cached')
  })

  it('says "failed" in the heading when the run did not pass', () => {
    // The heading is the first thing rendered, and a reviewer scanning a long
    // job page reads it before any row.
    const md = report([view({ taskId: 'a#test', status: 'failed', exitCode: 1 })], false)
    expect(md).toContain('## vx run — failed')
  })

  it('singularises a one-task run', () => {
    expect(headline(report([view({ taskId: 'a#build' })]))).toContain('**1 task**')
    expect(headline(report([view({ taskId: 'a#build' })]))).not.toContain('**1 tasks**')
  })

  it('omits skipped and aborted when there are none, and shows them when there are', () => {
    // These two buckets are conditional so a normal green run's headline stays
    // short. The failure mode of getting it wrong is noise, not a lie — but
    // the presence of "1 aborted" is genuinely load-bearing: an aborted task
    // is how a signal-killed run explains itself.
    const clean = headline(report([view({ taskId: 'a#build' })]))
    expect(clean).not.toContain('skipped')
    expect(clean).not.toContain('aborted')

    const messy = headline(
      report([
        view({ taskId: 'a#build' }),
        view({ taskId: 'a#test', status: 'skipped' }),
        view({ taskId: 'a#e2e', status: 'aborted' }),
      ]),
    )
    expect(messy).toContain('1 skipped')
    expect(messy).toContain('1 aborted')
  })

  it('counts both local and remote hits as cached', () => {
    const md = report([
      view({ taskId: 'a#build', status: 'cache-hit' }),
      view({ taskId: 'b#build', status: 'cache-hit-remote' }),
    ])
    expect(headline(md)).toContain('2 cached')
  })
})

describe('durations: what was spent vs what was saved', () => {
  it('totals only EXECUTED time, not restore time', () => {
    // "total" answers "how long did the work take". A cache hit did no work,
    // so folding its restore cost in would make a fully-warm run report a
    // total that grows with cache size.
    const md = report([
      view({ taskId: 'a#build', durationMs: 1500 }),
      view({ taskId: 'a#test', status: 'failed', exitCode: 1, durationMs: 500 }),
      // The restore cost is deliberately LARGE here. With a realistic 4ms
      // hit the difference rounds away and the assertion passes whether or
      // not the exclusion exists.
      view({ taskId: 'b#build', status: 'cache-hit', durationMs: 600, storedDurationMs: 9000 }),
    ])
    // 1500 + 500 = 2.00s executed; the hit's 600ms restore is not in it.
    expect(headline(md)).toContain('2.00s total')
    expect(headline(md)).not.toContain('2.60s total')
  })

  it('"saved" is the STORED exec time, not the restore this run paid', () => {
    // The 500× defect, pinned. A hit's `durationMs` is what the RESTORE cost —
    // milliseconds. Summing that reported a task that takes two seconds cold
    // as having saved four. The honest number is what the cache skipped, which
    // is the duration recorded when the entry was stored.
    const md = report([
      view({ taskId: 'a#build', status: 'cache-hit', durationMs: 4, storedDurationMs: 2010 }),
    ])
    expect(headline(md)).toContain('2.01s saved')
    expect(headline(md)).not.toContain('4ms saved')
  })

  it('makes NO saving claim for a hit that cannot substantiate one', () => {
    // Reachable only across a version skew — every hit this binary produces
    // carries its stored duration. The choice recorded at the call site is to
    // contribute zero rather than fall back to `durationMs`, so an outcome
    // that does not know what it skipped makes no claim instead of a
    // wrong-but-plausible one. With every hit unsubstantiated the clause
    // disappears entirely rather than reading "0ms saved".
    const md = report([view({ taskId: 'a#build', status: 'cache-hit', durationMs: 7 })])
    expect(headline(md)).not.toContain('saved')
  })

  it('formats sub-second in ms and anything longer in seconds', () => {
    // Two decimals of a second is unreadable at 12ms and three digits of ms is
    // unreadable at 90 seconds, so the unit switches at 1s.
    expect(rows(report([view({ taskId: 'a#b', durationMs: 999 })]))[0]).toContain('999ms')
    expect(rows(report([view({ taskId: 'a#b', durationMs: 1000 })]))[0]).toContain('1.00s')
    expect(rows(report([view({ taskId: 'a#b', durationMs: 90_500 })]))[0]).toContain('90.50s')
  })

  it('rounds fractional milliseconds rather than printing them', () => {
    expect(rows(report([view({ taskId: 'a#b', durationMs: 12.6 })]))[0]).toContain('13ms')
  })
})

describe('group tasks are excluded from both the table and the totals', () => {
  it('does not render an organisational node as a task row', () => {
    // The defect verbatim: a group has no command and no cache decision, so a
    // row reading `success | miss | 0ms` invents a task the user never wrote.
    // This repo's own `ci`, `lint` and `build` are groups, so its own PR
    // summaries carried them.
    const md = report([
      view({ taskId: 'a#ci', isGroup: true, durationMs: 0 }),
      view({ taskId: 'a#build', durationMs: 100 }),
    ])
    expect(rows(md)).toHaveLength(1)
    expect(md).not.toContain('a#ci')
  })

  it('does not count a group in the headline totals', () => {
    // The other half — the table and the header must agree, and both must
    // agree with the terminal summary. All three route through the same
    // shared tally for exactly this reason.
    // The groups carry a NON-ZERO duration on purpose: a group whose
    // duration is 0 is invisible in the totals whether or not it is excluded,
    // so a 0ms fixture would let the guard be deleted without failing.
    const md = report([
      view({ taskId: 'a#ci', isGroup: true, durationMs: 5000 }),
      view({ taskId: 'a#lint', isGroup: true, durationMs: 3000 }),
      view({ taskId: 'a#build', durationMs: 100 }),
    ])
    expect(headline(md)).toContain('**1 task**')
    expect(headline(md)).toContain('1 success')
    // …and the groups' time is not folded into the executed total either.
    expect(headline(md)).toContain('100ms total')
  })

  it('a run of nothing but groups reports zero tasks and an empty table', () => {
    const md = report([view({ taskId: 'a#ci', isGroup: true, durationMs: 0 })])
    expect(headline(md)).toContain('**0 tasks**')
    expect(rows(md)).toHaveLength(0)
    // The table chrome still renders, so a consumer parsing the markdown
    // always finds a well-formed (if empty) table.
    expect(md).toContain('| Task | Status | Cache | Duration |')
  })
})

describe('per-row status and cache words', () => {
  it('renders a cache hit as a SUCCESS whose cache column says where it came from', () => {
    // The two columns answer different questions: Status is "did this task
    // succeed", Cache is "did we do the work". Collapsing them would lose the
    // distinction the report exists to show.
    const md = report([
      view({ taskId: 'a#build', status: 'cache-hit' }),
      view({ taskId: 'b#build', status: 'cache-hit-remote' }),
    ])
    expect(rows(md)[0]).toBe('| a#build | success | local | 100ms |')
    expect(rows(md)[1]).toBe('| b#build | success | remote | 100ms |')
  })

  it('distinguishes an up-to-date tree from a restored one', () => {
    // `restored: false` means the output tree was already current so nothing
    // was written. It is still a hit, but "up-to-date" is the truthful word.
    const md = report([
      view({ taskId: 'a#build', status: 'cache-hit', restored: false }),
      view({ taskId: 'b#build', status: 'cache-hit-remote', restored: false }),
    ])
    expect(rows(md)[0]).toContain('| up-to-date |')
    expect(rows(md)[1]).toContain('| up-to-date |')
  })

  it('names the exit code on a failure', () => {
    // The actionable detail. A row saying only "failed" sends the reader to
    // the full log to learn what a single integer would have told them.
    const md = report([view({ taskId: 'a#test', status: 'failed', exitCode: 137 })])
    expect(rows(md)[0]).toContain('failed (exit 137)')
  })

  it('marks an executed task as a cache miss', () => {
    expect(rows(report([view({ taskId: 'a#b' })]))[0]).toContain('| miss |')
    expect(rows(report([view({ taskId: 'a#b', status: 'failed', exitCode: 1 })]))[0]).toContain(
      '| miss |',
    )
  })

  it.each([
    ['skipped', 'skipped'],
    ['aborted', 'aborted'],
  ])('passes a %s status through with an em-dash cache column', (status, word) => {
    // Neither reached a cache decision, so anything in that column would be an
    // invention. The em dash is the codebase's convention for "not applicable"
    // as opposed to zero.
    const md = report([view({ taskId: 'a#b', status: status as OutcomeView['status'] })])
    expect(rows(md)[0]).toContain(`| ${word} |`)
    expect(rows(md)[0]).toContain('| — |')
  })
})

describe('table cells are escaped — a task name is arbitrary user input', () => {
  // Task names are TypeScript object keys, so the loader accepts characters
  // that are structural in GFM. Unescaped, they do not error; they silently
  // corrupt the table a reviewer is reading.

  it('escapes a pipe so it cannot add a column', () => {
    const md = report([view({ taskId: 'a#build|test' })])
    expect(rows(md)[0]).toBe('| a#build\\|test | success | miss | 100ms |')
    // Four cells, still — count the unescaped separators.
    expect(
      rows(md)[0]
        ?.split(/(?<!\\)\|/)
        .filter((s) => s.trim() !== ''),
    ).toHaveLength(4)
  })

  it('flattens a newline so it cannot split the row', () => {
    // A newline is worse than a pipe: it terminates the row early, so every
    // following row shifts and the table's remaining content is orphaned as
    // loose text.
    const md = report([view({ taskId: 'a#build\ntest' })])
    expect(rows(md)[0]).toBe('| a#build test | success | miss | 100ms |')
    expect(rows(md)).toHaveLength(1)
  })

  it('flattens a CRLF as a single space, not two', () => {
    // `\r\n` is one line break. Replacing the characters individually would
    // leave a stray gap, and a bare `\r` would still confuse consumers.
    const md = report([view({ taskId: 'a#build\r\ntest' })])
    expect(rows(md)[0]).toContain('a#build test')
    expect(rows(md)[0]).not.toContain('\r')
  })

  it('escapes every occurrence, not just the first', () => {
    const md = report([view({ taskId: 'a|b|c' })])
    expect(rows(md)[0]).toContain('a\\|b\\|c')
  })

  it('keeps the table well-formed under a hostile name', () => {
    // The composite case: a name carrying both structural characters plus
    // markdown that would otherwise render. The row must stay one row of four
    // cells.
    const md = report([view({ taskId: 'evil#**x**|\n| --- |' })])
    expect(rows(md)).toHaveLength(1)
    expect(rows(md)[0]?.startsWith('| evil#**x**\\| ')).toBe(true)
  })
})

describe('structure', () => {
  it('always ends with a newline', () => {
    // Appended to `$GITHUB_STEP_SUMMARY`, which is shared with other steps —
    // without a trailing newline this report's last row and the next step's
    // first line would concatenate.
    expect(report([view({ taskId: 'a#b' })]).endsWith('\n')).toBe(true)
  })

  it('renders a well-formed table even for an empty run', () => {
    const md = report([])
    expect(headline(md)).toContain('**0 tasks**')
    expect(md).toContain('| Task | Status | Cache | Duration |')
    expect(md).toContain('| --- | --- | --- | --- |')
    expect(rows(md)).toHaveLength(0)
  })

  it('preserves outcome order', () => {
    // The report is a record of the run, so rows follow completion order
    // rather than being re-sorted — a reader correlating it with the log
    // depends on that.
    const md = report([
      view({ taskId: 'z#last' }),
      view({ taskId: 'a#first' }),
      view({ taskId: 'm#middle' }),
    ])
    expect(rows(md).map((r) => r.split(' | ')[0])).toEqual(['| z#last', '| a#first', '| m#middle'])
  })

  it('emits no ANSI — the report is machine-clean by construction', () => {
    // The header states this as a property of the STRING (stdout is shared
    // with the status logger, which is why `--report-file` exists). A colour
    // code leaking in here would corrupt every consumer that is not a
    // terminal.
    const md = report([
      view({ taskId: 'a#build', status: 'failed', exitCode: 1 }),
      view({ taskId: 'b#build', status: 'cache-hit', storedDurationMs: 500 }),
    ])
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(md)).toBe(false)
  })
})
