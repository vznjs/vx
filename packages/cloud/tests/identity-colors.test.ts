// A project name must never be painted in a verdict colour.
//
// The dashboard has three colour vocabularies: STATUS (success / warn /
// danger — a verdict), CACHE (local / remote — where a result came from) and
// IDENTITY (`ident-0..5` for a project, fixed pink for a task). Identity was
// given its own set on 2026-07-25 precisely because the categorical ramp it
// replaced overlapped the status palette. That wave repointed `tasks.json`'s
// dots and stopped; six more surfaces kept hashing project names onto
// `chart-1..8`.
//
// Measured against the real token table before the sweep: SEVEN of the eight
// ramp steps were byte-identical to another token and FIVE to a semantic one
// (`chart-3` IS `--success`, `chart-4` IS `--warn`), so 25.4% of project names
// — 128 of 504 generated — rendered their identity dot in a verdict colour.
//
// This guard reads SOURCE rather than importing the dashboard: `packages/cloud/
// tsconfig.json` deliberately scopes to `src/` + `tests/` and sets no `jsx`,
// and the UI compiles under its own tsconfig (the same reason
// `status-vocabulary.test.ts` reads source). Every extraction is strict — a
// shape it cannot parse THROWS rather than passing vacuously.

import { describe, expect, it } from 'bun:test'

const UI = new URL('../ui/', import.meta.url)
const read = (rel: string) => Bun.file(new URL(rel, UI)).text()

const unoSrc = await read('uno.config.ts')
const formatSrc = await read('src/format.ts')
const componentsSrc = await read('src/jr/components.tsx')
const functionsSrc = await read('src/jr/functions.ts')
const chartsSrc = await read('src/components/charts.tsx')

const viewNames = [
  ...new Bun.Glob('*.json').scanSync({ cwd: new URL('src/views/', UI).pathname }),
].sort()
const views = new Map<string, string>()
for (const name of viewNames) views.set(name, await read(`src/views/${name}`))

/** The `--name: R G B;` table out of uno.config.ts. */
function readTokens(src: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>()
  for (const m of src.matchAll(/--([a-z0-9-]+):\s*(\d+ \d+ \d+)\s*;/g)) tokens.set(m[1]!, m[2]!)
  // Non-vacuity: the theme carries ~25 tokens. A parser matching none would
  // make every assertion below trivially pass.
  if (tokens.size < 15) {
    throw new Error(
      `parsed only ${tokens.size} colour tokens from uno.config.ts — the extraction is broken, not the code`,
    )
  }
  return tokens
}

const tokens = readTokens(unoSrc)
const VERDICT = ['success', 'warn', 'danger'] as const
const IDENTITY = [
  'ident-0',
  'ident-1',
  'ident-2',
  'ident-3',
  'ident-4',
  'ident-5',
  'ident-task',
] as const

describe('the identity palette', () => {
  it('is byte-distinct from every verdict colour', () => {
    // The structural property that makes an identity hue safe to hash onto.
    // The retired ramp violated it at two of eight steps.
    const verdictRgb = new Set(VERDICT.map((v) => tokens.get(v)))
    expect(verdictRgb.size).toBe(VERDICT.length)
    expect(IDENTITY.filter((i) => verdictRgb.has(tokens.get(i)))).toEqual([])
  })

  it('defines every hue it claims', () => {
    expect(IDENTITY.filter((i) => tokens.get(i) === undefined)).toEqual([])
  })

  it('safelists fill-, bg- and text- for every hashable hue', () => {
    // identFor returns ident-0..5. The Treemap paints SVG <rect> (fill-), dots
    // and bars use bg-, project names use text-. UnoCSS cannot see any of them
    // statically, so an unlisted one renders as no colour at all — silently.
    expect(unoSrc).toContain('`fill-ident-${n}`')
    expect(unoSrc).toContain('`bg-ident-${n}`')
    expect(unoSrc).toContain('`text-ident-${n}`')
    expect(unoSrc).toContain("'bg-ident-task'")
    expect(unoSrc).toContain("'text-ident-task'")
  })
})

describe('the retired categorical ramp', () => {
  it('is gone from the theme', () => {
    expect(unoSrc).not.toMatch(/--chart-\d/)
    expect(unoSrc).not.toMatch(/chart-\$\{n\}/)
  })

  it('has no producer left', () => {
    // `paletteFor` is what hashed a name onto the ramp. Leaving it callable is
    // how the 2026-07-25 sweep left six surfaces behind.
    expect(formatSrc).not.toContain('export function paletteFor')
    for (const [file, src] of [
      ['src/jr/components.tsx', componentsSrc],
      ['src/jr/functions.ts', functionsSrc],
    ] as const) {
      expect(`${file}: ${src.includes('paletteFor(')}`).toBe(`${file}: false`)
    }
  })

  it('has no consumer left in any component or view', () => {
    const offenders: string[] = []
    const scan = (file: string, src: string) => {
      for (const [i, line] of src.split('\n').entries()) {
        if (
          /\bchart-\d\b/.test(line) &&
          !line.trimStart().startsWith('*') &&
          !line.trimStart().startsWith('//')
        ) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    scan('src/jr/components.tsx', componentsSrc)
    scan('src/components/charts.tsx', chartsSrc)
    scan('src/format.ts', formatSrc)
    for (const [name, src] of views) scan(`src/views/${name}`, src)
    expect(offenders).toEqual([])
  })
})

describe('view call sites', () => {
  it('reads every shipped view', () => {
    // Non-vacuity: eleven views ship today. A glob that matched nothing would
    // make the two assertions below pass over an empty set.
    expect(viewNames.length).toBeGreaterThanOrEqual(8)
  })

  it('declares no dot map that is not part of the vocabulary', () => {
    // The `dots: [{ field, map }]` vocabulary is closed — `colorOf` falls
    // through to identity for anything else, so an unknown map is a silent
    // mis-colour, not an error.
    const KNOWN = new Set(['ident', 'ci', 'heat', 'failureMode', 'delta', 'keyChanged', 'triage'])
    const offenders: string[] = []
    let seen = 0
    for (const [name, src] of views) {
      for (const m of src.matchAll(/"map":\s*"([a-zA-Z]+)"/g)) {
        seen++
        if (!KNOWN.has(m[1]!)) offenders.push(`src/views/${name}: "map": "${m[1]}"`)
      }
    }
    // Non-vacuity: the shipped views declare a dozen-plus dot maps.
    expect(seen).toBeGreaterThanOrEqual(8)
    expect(offenders).toEqual([])
  })

  it('still colours identities — the sweep did not just delete colour', () => {
    // The control: "no ramp" must not have been achieved by dropping the hue
    // entirely. Projects/tasks/cache all carry an identity dot or bar.
    const identDots = [...views.values()].filter((s) => s.includes('"map": "ident"')).length
    const colorFrom = [...views.values()].filter((s) => s.includes('"colorFrom"')).length
    expect(identDots).toBeGreaterThanOrEqual(3)
    expect(colorFrom).toBeGreaterThanOrEqual(2)
  })
})

describe('chart series', () => {
  it('paints a neutral metric in a neutral colour', () => {
    // A series takes its colour from what it IS: a status, an identity, or the
    // sole line. `stroke-chart-3` was byte-identical to `--success`, so the
    // parallelism factor — a neutral efficiency ratio — read as a verdict.
    const strokes = new Set<string>()
    for (const src of views.values()) {
      for (const m of src.matchAll(
        /"(?:stroke|area)Class":\s*"(?:stroke|fill)-([a-z0-9-]+)(?:\/\d+)?"/g,
      )) {
        strokes.add(m[1]!)
      }
    }
    // Non-vacuity: ten series ship across four views.
    expect(strokes.size).toBeGreaterThanOrEqual(4)
    // Every series token must resolve in the theme — a stroke naming a deleted
    // token renders as no line at all.
    expect([...strokes].filter((s) => tokens.get(s) === undefined)).toEqual([])
    // …and must be NAMED for what the series is. `danger` on a failures line
    // and `warn` on a flakiness line are verdicts about verdict data, which is
    // correct; a hashed ramp step that merely happens to equal `--success` is
    // not. The list is closed so a new series has to make the call deliberately.
    const SERIES_VOCABULARY = new Set([
      'accent', // the primary / sole line
      'accent-2', // a second neutral line (storage, growth)
      'info', // a neutral rate or ratio
      'cache-local', // cache hits — the cache vocabulary
      'cache-remote',
      'success', // a verdict, for verdict data only
      'warn',
      'danger',
    ])
    expect([...strokes].filter((s) => !SERIES_VOCABULARY.has(s))).toEqual([])
  })
})
