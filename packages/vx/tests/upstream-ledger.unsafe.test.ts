// docs/upstream-ledger.md cites, for each Turborepo and Nx bug report it
// maps, the vx test that would fail if vx had the bug: `file › "title"`.
// A citation is only worth what the test behind it is, and a test renamed
// or deleted leaves the row claiming a pin nobody holds. This law reads
// every cited file and asks whether the title is one of its `it(…)` /
// `test(…)` titles, exactly as JS reads the literal.
//
// `.unsafe`: the ledger cites suites in other packages (vx-migrate,
// vx-lockfile), which the cross-project law forbids a sandboxed shard.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const LEDGER = path.join(repo, 'packages', 'vx', 'docs', 'upstream-ledger.md')

/**
 * The first argument of `it(` / `test(`, modifiers allowed between
 * (`it.skipIf(x)(`, `test.each(rows)(`), as a quoted literal. A template
 * holding `${` builds its title at run time: it is no literal and cannot be
 * cited, so it is left out rather than guessed at.
 */
const TITLE =
  /\b(?:it|test)(?:\.[A-Za-z]+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g

/** A string literal's body as JS decodes it. */
function decode(body: string): string {
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g,
    (_, e: string) => {
      if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16))
      if (e.length === 5 && e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16))
      if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16))
      if (e === '\n' || e === '\r\n') return ''
      return (
        ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as const)[e as 'n'] ??
        e
      )
    },
  )
}

function titlesOf(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(TITLE)) {
    if (m[1] === '`' && m[2]!.includes('${')) continue
    out.add(decode(m[2]!))
  }
  return out
}

interface Row {
  line: number
  issue: string
  verdict: string
  cites: Array<{ file: string; title: string }>
  /** A test cell segment that is not a citation — a malformed row. */
  stray: string[]
}

/** The ledger's table rows: cells split on unescaped `|`, the test cell on `<br>`. */
function rows(markdown: string): Row[] {
  const out: Row[] = []
  markdown.split('\n').forEach((text, i) => {
    if (!text.startsWith('|') || /^\|\s*(?:issue|-+)\s*\|/.test(text)) return
    const cells = text
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim())
    const segments = (cells[3] ?? '').split('<br>').filter((s) => s !== '')
    const row: Row = { line: i + 1, issue: cells[0]!, verdict: cells[2]!, cites: [], stray: [] }
    for (const s of segments) {
      const m = /^`([^`]+\.test\.ts)` › "(.*)"$/.exec(s)
      if (m === null) row.stray.push(s)
      else row.cites.push({ file: m[1]!, title: m[2]!.replace(/\\\|/g, '|') })
    }
    out.push(row)
  })
  return out
}

/** Every citation that names no test, as `line: file › title` — empty when the ledger holds. */
function unheld(markdown: string, read: (file: string) => string | null): string[] {
  const titles = new Map<string, Set<string> | null>()
  const out: string[] = []
  for (const row of rows(markdown)) {
    for (const s of row.stray) out.push(`${row.line}: not a citation: ${s}`)
    if (row.verdict === 'covered' && row.cites.length === 0) {
      out.push(`${row.line}: covered cites nothing`)
    }
    for (const { file, title } of row.cites) {
      if (!titles.has(file)) {
        const source = read(file)
        titles.set(file, source === null ? null : titlesOf(source))
      }
      const known = titles.get(file)
      if (known === null) out.push(`${row.line}: no such file: ${file}`)
      else if (!known!.has(title)) out.push(`${row.line}: ${file} › "${title}"`)
    }
  }
  return out
}

const readRepo = (file: string): string | null => {
  const abs = path.join(repo, file)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

describe('docs/upstream-ledger.md', () => {
  const ledger = readFileSync(LEDGER, 'utf8')

  it('every cited test title is a test in the file it names', () => {
    expect(unheld(ledger, readRepo)).toEqual([])
  })

  it('reads every row of both tables, and each verdict is one the page defines', () => {
    const all = rows(ledger)
    // Non-vacuity: a parser that stopped matching would pass the row above
    // over an empty table.
    expect(all.length).toBeGreaterThanOrEqual(300)
    expect(all.reduce((n, r) => n + r.cites.length, 0)).toBeGreaterThanOrEqual(250)
    const verdicts = new Set(
      all.map((r) =>
        r.verdict
          .replace(/^fixed-in-item-\d+$/, 'fixed-in-item-N')
          .replace(/^open \(.+\)$/, 'open (id)'),
      ),
    )
    expect([...verdicts].sort()).toEqual(['covered', 'fixed-in-item-N', 'n/a', 'open (id)'])
  })

  // The law's own control: each way a citation can rot is caught.
  it('a misspelled title, a missing file, a template title and an uncited covered row are each named', () => {
    const src = [
      "it('a real title', () => {})",
      'it(`built ${"from"} a template`, () => {})',
      "test.skipIf(false)('an \\u2019escaped\\u2019 title', () => {})",
    ].join('\n')
    const read = (file: string) => (file === 'x/a.test.ts' ? src : null)
    const table = [
      '| issue | class | verdict | vx test | note |',
      '| --- | --- | --- | --- | --- |',
      '| [a] | c | covered | `x/a.test.ts` › "a real title"<br>`x/a.test.ts` › "an ’escaped’ title" |  |',
      '| [b] | c | covered | `x/a.test.ts` › "a real titel" |  |',
      '| [c] | c | covered | `x/b.test.ts` › "a real title" |  |',
      '| [d] | c | covered | `x/a.test.ts` › "built from a template" |  |',
      '| [e] | c | covered |  |  |',
      '| [f] | c | n/a |  | why |',
    ].join('\n')
    expect(unheld(table, read)).toEqual([
      '4: x/a.test.ts › "a real titel"',
      '5: no such file: x/b.test.ts',
      '6: x/a.test.ts › "built from a template"',
      '7: covered cites nothing',
    ])
  })
})
