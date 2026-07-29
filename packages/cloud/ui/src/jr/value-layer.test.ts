// The value layer's absence convention.
//
// The pure-JSON views call these by name through `$computed`, so this is the
// last hop before a number becomes a sentence a developer reads. It has ONE
// rule, and the rule is the whole point:
//
//   an ABSENT source (the fetch failed, or has not resolved) yields NaN, which
//   the format layer renders '—'
//   an EMPTY array yields a real 0
//
// Those two are easy to conflate and the consequences are opposite. "0 flaky
// tasks" on a workspace that IS clean is useful; the same words on a FAILED
// probe are a confident lie, and this dashboard shipped exactly that — a green
// `tone=good` tile reading "Flaky tasks: 0" when the source had errored, so it
// was not even a neutral zero but an affirmative "you're clean". The same wave
// found `countCold`/`coldBytes` rendering `0` and `0 B` on a failed `/entries`
// fetch because they gated on a CAPABILITY rather than their source's status.
//
// The tone helpers carry the other half: on an unknown value they must pick
// NEITHER branch, because `else` is what painted that tile green.
//
// `absent` is `!Array.isArray(v)`, so undefined / null / a pending resource /
// an error object are all "absent" — and only a genuine array is data.

import { describe, expect, it } from 'bun:test'
import { FUNCTIONS } from './functions.js'

const call = (name: string, args: Record<string, unknown>): unknown => {
  const fn = FUNCTIONS[name]
  if (fn === undefined) throw new Error(`no such value-layer function: ${name}`)
  return fn(args)
}

/** Everything a json-render source can be while it is NOT an array of rows. */
const ABSENT_SOURCES: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined — the source has not resolved', undefined],
  ['null — an explicit failure sentinel', null],
  ['a string — an HTML error page that reached the binding', 'error'],
  ['a number', 0],
  ['an object — an unwrapped {error} payload', { error: 'boom' }],
  ['a bare error', new Error('fetch failed')],
]

describe('absent vs empty — the distinction the whole layer rests on', () => {
  // Each pair is: the aggregator, args that make it meaningful, and the value
  // an EMPTY array must produce. Absent must produce NaN for every one.
  const scalars: ReadonlyArray<readonly [string, Record<string, unknown>, number]> = [
    ['agg (count)', { op: 'count', field: 'x' }, 0],
    ['agg (sum)', { op: 'sum', field: 'x' }, 0],
    ['agg (avg)', { op: 'avg', field: 'x' }, 0],
    ['agg (max)', { op: 'max', field: 'x' }, 0],
    ['countWhere', { field: 'status', eq: 'failed' }, 0],
    ['countCold', {}, 0],
    ['span', { start: 'startedAt', end: 'endedAt' }, 0],
  ]

  for (const [name, args, whenEmpty] of scalars) {
    const fnName = name.split(' ')[0]!

    for (const [what, source] of ABSENT_SOURCES) {
      it(`${name} is UNKNOWN for ${what}`, () => {
        const v = call(fnName, { ...args, arr: source })
        expect(Number.isFinite(v as number)).toBe(false)
      })
    }

    it(`${name} is a real ${whenEmpty} for an EMPTY array`, () => {
      // The other half. A workspace with nothing to report must read 0, not
      // '—' — otherwise a genuinely clean state looks like a broken one.
      expect(call(fnName, { ...args, arr: [] })).toBe(whenEmpty)
    })
  }

  it('coldBytes renders the em dash for an absent source, not "0 B"', () => {
    // Byte counts go through the format layer rather than out as a number, so
    // this one is asserted on the STRING a user sees. `0 B` on a failed fetch
    // is the exact wording this shipped with.
    for (const [, source] of ABSENT_SOURCES) {
      expect(call('coldBytes', { arr: source })).toBe('—')
    }
  })

  it('coldBytes renders a real "0 B" for an empty array', () => {
    expect(call('coldBytes', { arr: [] })).toBe('0 B')
  })
})

describe('aggregates over real rows', () => {
  const rows = [{ x: 10 }, { x: 20 }, { x: 30 }]

  it('counts, sums, averages and maxes', () => {
    expect(call('agg', { arr: rows, op: 'count', field: 'x' })).toBe(3)
    expect(call('agg', { arr: rows, op: 'sum', field: 'x' })).toBe(60)
    expect(call('agg', { arr: rows, op: 'avg', field: 'x' })).toBe(20)
    expect(call('agg', { arr: rows, op: 'max', field: 'x' })).toBe(30)
  })

  it('defaults to sum when no op is given', () => {
    // The JSON views rely on this — most bindings omit `op`.
    expect(call('agg', { arr: rows, field: 'x' })).toBe(60)
  })

  it('FINDING: one row MISSING the field turns the whole sum unknown', () => {
    // Recorded, not endorsed. `n` is `Number(v)`, and `Number(undefined)` is
    // NaN, so a single sparse row poisons the reduce and a populated tile
    // renders '—'. It fails SAFE — hiding data rather than inventing it, the
    // right direction — but it is still wrong: the honest answer for a sparse
    // row is to skip it, the way `countWhere` skips a non-matching one.
    //
    // Reachable wherever a row shape is optional-by-design; the analytics
    // reads return plenty of those. Contrast the `null` case directly below,
    // which fails the OTHER way and is the more dangerous of the two.
    const sparse = [{ x: 10 }, { other: 1 }, { x: 5 }]
    expect(Number.isFinite(call('agg', { arr: sparse, op: 'sum', field: 'x' }) as number)).toBe(
      false,
    )
    // `count` is field-independent, so it still answers honestly.
    expect(call('agg', { arr: sparse, op: 'count', field: 'x' })).toBe(3)
  })

  it('a JSON null field sums as zero rather than poisoning the total', () => {
    // `Number(null)` is 0, so a nulled row is absorbed. Benign for a SUM —
    // and precisely why the same coercion is NOT benign for a scalar, below.
    expect(call('agg', { arr: [{ x: 10 }, { x: null }, { x: 5 }], op: 'sum', field: 'x' })).toBe(15)
  })

  it('max floors at 0 rather than answering -Infinity on an empty array', () => {
    // `Math.max()` with no arguments is -Infinity, which would render '—' and
    // read as "unknown" for a genuinely empty set.
    expect(call('agg', { arr: [], op: 'max', field: 'x' })).toBe(0)
  })

  it('counts rows by field equality, including a zero and a false', () => {
    const mixed = [{ s: 'ok' }, { s: 'fail' }, { s: 'ok' }, { s: 0 }, { s: false }]
    expect(call('countWhere', { arr: mixed, field: 's', eq: 'ok' })).toBe(2)
    // Strict equality: a falsy value is still a value to match on.
    expect(call('countWhere', { arr: mixed, field: 's', eq: 0 })).toBe(1)
    expect(call('countWhere', { arr: mixed, field: 's', eq: false })).toBe(1)
    expect(call('countWhere', { arr: mixed, field: 's', eq: 'missing' })).toBe(0)
  })
})

describe('span — run wall time', () => {
  it('is max(end) - min(start), not last minus first', () => {
    // Rows arrive in completion order, not start order, so a naive
    // `last.end - first.start` would under-report whenever the longest task
    // did not finish last.
    const rows = [
      { s: 100, e: 900 },
      { s: 50, e: 400 },
      { s: 600, e: 700 },
    ]
    expect(call('span', { arr: rows, start: 's', end: 'e' })).toBe(850)
  })

  it('is 0 for a single instantaneous row', () => {
    expect(call('span', { arr: [{ s: 5, e: 5 }], start: 's', end: 'e' })).toBe(0)
  })

  it('does not blow the stack on a very large run', () => {
    // `Math.max(...rows)` spreads every row as an argument. The compare view
    // already hit this class once — a 700-task run truncating — so a
    // realistically large run is pinned rather than assumed safe.
    const many = Array.from({ length: 50_000 }, (_, i) => ({ s: i, e: i + 1 }))
    expect(call('span', { arr: many, start: 's', end: 'e' })).toBe(50_000)
  })
})

describe('tone helpers must not paint an unknown value', () => {
  // The half of the F1 fix that mattered most: a failed source must pick
  // NEITHER branch. Returning `else` is what made a broken tile render green
  // with an affirmative "you're clean".
  it('aggTone is default for an absent source, never the else branch', () => {
    for (const [, source] of ABSENT_SOURCES) {
      expect(
        call('aggTone', { arr: source, op: 'count', field: 'x', gt: 0, then: 'bad', else: 'good' }),
      ).toBe('default')
    }
  })

  it('aggTone still takes the else branch for a genuine zero', () => {
    // The control. An EMPTY array is real data meaning "none", so it may be
    // painted — the distinction this whole file exists for.
    expect(
      call('aggTone', { arr: [], op: 'count', field: 'x', gt: 0, then: 'bad', else: 'good' }),
    ).toBe('good')
  })

  it('aggTone takes the then branch above the threshold', () => {
    expect(
      call('aggTone', {
        arr: [{ x: 1 }, { x: 1 }],
        op: 'count',
        field: 'x',
        gt: 1,
        then: 'bad',
        else: 'good',
      }),
    ).toBe('bad')
  })

  const unknowns: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a non-numeric string', 'n/a'],
  ]

  for (const [what, v] of unknowns) {
    it(`gt is default for ${what}`, () => {
      expect(call('gt', { v, n: 0, then: 'bad', else: 'good' })).toBe('default')
    })
    it(`lt is default for ${what}`, () => {
      expect(call('lt', { v, n: 0, then: 'bad', else: 'good' })).toBe('default')
    })
  }

  it('gt and lt are strict, so the boundary itself takes the else branch', () => {
    expect(call('gt', { v: 5, n: 5, then: 'bad', else: 'good' })).toBe('good')
    expect(call('gt', { v: 6, n: 5, then: 'bad', else: 'good' })).toBe('bad')
    expect(call('lt', { v: 5, n: 5, then: 'bad', else: 'good' })).toBe('good')
    expect(call('lt', { v: 4, n: 5, then: 'bad', else: 'good' })).toBe('bad')
  })

  it('falls back to default when no else branch is supplied', () => {
    expect(call('gt', { v: 1, n: 5, then: 'bad' })).toBe('default')
  })

  it('paints a real zero, which is the point of separating it from absent', () => {
    // `v: 0` is finite, so it must be judged rather than treated as unknown.
    expect(call('gt', { v: 0, n: 0, then: 'bad', else: 'good' })).toBe('good')
    expect(call('lt', { v: 0, n: 1, then: 'bad', else: 'good' })).toBe('bad')
  })
})

describe('FINDING: a JSON null reads as a confident zero, not as unknown', () => {
  // The sharpest thing in this file, and the same class as the "Flaky tasks: 0"
  // tile the F1 wave fixed — still open for one input shape.
  //
  // `n` is `Number(v)`, and `Number(null)` is **0** while `Number(undefined)`
  // is NaN. So a field that arrives as JSON `null` is not treated as unknown:
  // it is treated as a measured zero. The tile renders `0 B` / `<1ms` and the
  // tone helpers PAINT it, rather than falling back to '—' and 'default'.
  //
  // That is reachable, not theoretical. `null` is exactly what a SQL aggregate
  // over zero rows returns, and CLAUDE.md's 2026-07-17 sweep records
  // NULL-aggregate-into-non-null-number as a class the SERVER was audited for
  // — the client's coercion then converts whatever slips through into a
  // confident zero, which is the failure the server-side sweep existed to
  // prevent.
  //
  // Pinned as CURRENT behaviour, deliberately not fixed here: `n` is shared by
  // every helper in this module, so mapping null → NaN needs its own pass over
  // the call sites rather than riding a test change.
  it('formats null as a real value instead of the em dash', () => {
    expect(call('fmtBytes', { b: null })).toBe('0 B')
    expect(call('fmtDuration', { ms: null })).toBe('<1ms')
    expect(call('fmtNumber', { n: null })).toBe('0')
  })

  it('paints a tone for null instead of declining to judge', () => {
    // `gt` sees a finite 0 and takes the `else` branch — the exact shape that
    // rendered a broken tile green.
    expect(call('gt', { v: null, n: 0, then: 'bad', else: 'good' })).toBe('good')
    expect(call('lt', { v: null, n: 1, then: 'bad', else: 'good' })).toBe('bad')
  })

  it('undefined, by contrast, IS treated as unknown', () => {
    // The control that makes the finding legible: the two absent-ish shapes
    // diverge, and only one of them is handled.
    expect(call('fmtBytes', { b: undefined })).toBe('—')
    expect(call('gt', { v: undefined, n: 0, then: 'bad', else: 'good' })).toBe('default')
  })
})

describe('formatters render the em dash for an unknown value', () => {
  // The convention the F1 fix completed: non-finite ⇒ '—'. Without it a tile
  // reads 'NaN' or '0', and one of those is a lie rather than an obvious bug.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['fmtDuration', 'ms'],
    ['fmtBytes', 'b'],
    ['fmtCount', 'n'],
    ['fmtPercent', 'n'],
    ['fmtPercent0', 'n'],
    ['fmtNumber', 'n'],
  ]

  for (const [fn, key] of cases) {
    // `null` is deliberately absent from this list — it coerces to a real 0
    // and is pinned as a FINDING in the block above.
    for (const [what, v] of [
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['a non-numeric string', 'oops'],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      it(`${fn} renders the em dash for ${what}`, () => {
        expect(call(fn, { [key]: v })).toBe('—')
      })
    }
  }

  it('formats real values rather than swallowing them', () => {
    // The control: the em-dash rule must not be so broad it eats zeros.
    expect(call('fmtCount', { n: 0 })).not.toBe('—')
    expect(call('fmtBytes', { b: 0 })).toBe('0 B')
    expect(call('fmtNumber', { n: 0 })).toBe('0')
    expect(call('fmtNumber', { n: 3.7 })).toBe('4')
  })

  it('fmtSignedDuration keeps a NEGATIVE delta rather than reading it as absent', () => {
    // A faster delta is the good news on the compare view. Treating the sign
    // as unknown would hide exactly the result a developer wants.
    const faster = call('fmtSignedDuration', { ms: -1200 })
    expect(faster).not.toBe('—')
    expect(String(faster)).toContain('1.2')
  })
})

describe('ratioFmt', () => {
  const rows = [
    { hits: 3, total: 4 },
    { hits: 1, total: 6 },
  ]

  it('divides the summed numerator by the summed denominator', () => {
    expect(call('ratioFmt', { arr: rows, a: 'hits', b: 'total', fmt: 'percent' })).toBe('40.0%')
  })

  it('is unknown rather than zero when the denominator is 0', () => {
    // A rate over nothing is not 0% — that would claim a measured result. The
    // hit-rate tile reads '—' until there is something to divide by.
    expect(call('ratioFmt', { arr: [{ hits: 0, total: 0 }], a: 'hits', b: 'total', fmt: 'percent' }))
      .toBe('—')
  })

  it('is unknown for an absent source', () => {
    for (const [, source] of ABSENT_SOURCES) {
      expect(call('ratioFmt', { arr: source, a: 'hits', b: 'total', fmt: 'percent' })).toBe('—')
    }
  })

  it('is unknown for an empty array, since there is still nothing to divide', () => {
    expect(call('ratioFmt', { arr: [], a: 'hits', b: 'total', fmt: 'percent' })).toBe('—')
  })

  it('is unknown for a NEGATIVE denominator rather than a nonsensical rate', () => {
    // The guard is `b > 0`, not `b !== 0`, and only this case proves it: a
    // zero denominator yields NaN through plain division anyway, so every
    // other case here passes with the guard REMOVED. Ungated, this renders
    // '-250.0%' — a confident, meaningless number in a rate tile.
    expect(call('ratioFmt', { arr: [{ hits: 5, total: -2 }], a: 'hits', b: 'total', fmt: 'percent' }))
      .toBe('—')
  })
})

describe('text templating', () => {
  it('substitutes named slots', () => {
    expect(call('text', { tpl: '{a} of {b} runs', a: 3, b: 10 })).toBe('3 of 10 runs')
  })

  it('renders an em dash for an unknown numeric slot, never the literal NaN', () => {
    expect(call('text', { tpl: '{a} of {b}', a: Number.NaN, b: 10 })).toBe('— of 10')
  })

  it('renders an absent slot as empty rather than "undefined"', () => {
    expect(call('text', { tpl: 'x{a}y' })).toBe('xy')
  })

  it('leaves an unmatched brace pattern alone', () => {
    expect(call('text', { tpl: '{a} {b}', a: 1 })).toBe('1 ')
  })

  it('substitutes a real zero rather than dropping it', () => {
    expect(call('text', { tpl: '{n} failed', n: 0 })).toBe('0 failed')
  })
})

describe('cache entry heat', () => {
  const now = Date.now()

  it('marks an entry never re-hit since creation as cold', () => {
    // "Cold" means written but never served — the reclaimable set. The
    // tolerance exists because the write and its first access share a moment.
    const entries = [{ project: 'p', task: 't', createdAt: now - 1000, accessedAt: now - 1000 }]
    const out = call('coldEntries', { arr: entries }) as Array<Record<string, unknown>>
    expect(out[0]!['_heat']).toBe('cold')
    expect(out[0]!['_taskId']).toBe('p#t')
  })

  it('marks a long-unused but once-hit entry stale, not cold', () => {
    const entries = [
      { project: 'p', task: 't', createdAt: now - 90 * 86_400_000, accessedAt: now - 60 * 86_400_000 },
    ]
    const out = call('coldEntries', { arr: entries }) as Array<Record<string, unknown>>
    expect(out[0]!['_heat']).toBe('stale')
  })

  it('marks a recently used entry warm', () => {
    const entries = [{ project: 'p', task: 't', createdAt: now - 86_400_000, accessedAt: now - 60_000 }]
    const out = call('coldEntries', { arr: entries }) as Array<Record<string, unknown>>
    expect(out[0]!['_heat']).toBe('warm')
  })

  it('treats an entry with unusable timestamps as warm, not cold', () => {
    // Cold drives a "reclaimable" figure a user may act on by pruning, so an
    // entry we cannot date must not be counted reclaimable.
    const entries = [{ project: 'p', task: 't' }]
    const out = call('coldEntries', { arr: entries }) as Array<Record<string, unknown>>
    expect(out[0]!['_heat']).toBe('warm')
    expect(call('countCold', { arr: entries })).toBe(0)
  })

  it('preserves the original row fields alongside the annotations', () => {
    const entries = [{ project: 'p', task: 't', hash: 'abc', sizeBytes: 42, createdAt: 1, accessedAt: 1 }]
    const out = call('coldEntries', { arr: entries }) as Array<Record<string, unknown>>
    expect(out[0]!['hash']).toBe('abc')
    expect(out[0]!['sizeBytes']).toBe(42)
  })

  it('sums only the cold entries into the reclaimable figure', () => {
    const entries = [
      { project: 'p', task: 't', sizeBytes: 100, createdAt: now - 1000, accessedAt: now - 1000 },
      { project: 'p', task: 'u', sizeBytes: 900, createdAt: now - 86_400_000, accessedAt: now - 60_000 },
    ]
    expect(call('countCold', { arr: entries })).toBe(1)
    expect(call('coldBytes', { arr: entries })).toBe('100 B')
  })
})
