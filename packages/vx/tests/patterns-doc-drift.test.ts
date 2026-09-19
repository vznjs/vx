// patterns.md anchors every parity claim in a source comment and cited
// them by line number; by 2026-09-16 (item 297) eight of the fourteen
// line numbers pointed past the file split that moved them (CacheKeyInput
// to layer.ts, the package.json fold to task-hash.ts) and two quoted
// phrases appeared nowhere. The citations are file + phrase now, and each
// phrase must appear in the file it is cited from.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')

describe('patterns.md cites phrases its source files contain', () => {
  it('every `src/x.ts` ("phrase") pair resolves', () => {
    const doc = readFileSync(path.join(pkg, 'docs', 'patterns.md'), 'utf8')
    const pairs = [...doc.matchAll(/`(src\/[A-Za-z0-9_./-]+\.ts)` \("([^"]+)"\)/g)]
    expect(pairs.length).toBeGreaterThan(5)
    const missing: string[] = []
    for (const [, file, phrase] of pairs) {
      const text = readFileSync(path.join(pkg, file!), 'utf8')
      if (!text.includes(phrase!)) missing.push(`${file}: "${phrase}"`)
    }
    expect(missing).toEqual([])
  })

  it('cites no line numbers — they rot with every split', () => {
    const doc = readFileSync(path.join(pkg, 'docs', 'patterns.md'), 'utf8')
    expect([...doc.matchAll(/`src\/[A-Za-z0-9_./-]+\.ts:\d+`/g)].map((m) => m[0])).toEqual([])
  })
})

// flows.md names an OWNER per flow as `module/file.ts`, sometimes with the
// symbol that does the work (`cache/cache.ts:prune`). Nothing held them
// until item 353 (2026-09-19): patterns.md's citations had already rotted
// on a split once, and these are the same shape, one file-move away from
// pointing at nothing.
describe('flows.md names owners that exist', () => {
  const doc = readFileSync(path.join(pkg, 'docs', 'flows.md'), 'utf8')
  it('every `module/file.ts` owner resolves, with its symbol', () => {
    const cites = [...doc.matchAll(/`([a-z-]+\/[a-z-]+\.ts)(?::(\w+))?`/g)]
    expect(cites.length).toBeGreaterThan(10)
    const missing: string[] = []
    for (const [, file, symbol] of cites) {
      const abs = path.join(pkg, 'src', file!)
      if (!existsSync(abs)) {
        missing.push(`no such file: ${file}`)
        continue
      }
      if (symbol !== undefined && !readFileSync(abs, 'utf8').includes(symbol)) {
        missing.push(`${file} has no ${symbol}`)
      }
    }
    expect(missing).toEqual([])
  })
  it('cites no line numbers either', () => {
    expect([...doc.matchAll(/`[a-z-]+\/[a-z-]+\.ts:\d+`/g)].map((m) => m[0])).toEqual([])
  })
})

// Its performance table is a COPY of one in benchmarks.md, and four other
// pages that quote those numbers are pinned against that page while this one
// — a contract doc — was not (item 383, 2026-09-19). Row-wise, not
// figure-wise: the three cells after the runner's name must appear together
// on a benchmarks.md row, so a figure cannot drift onto the wrong runner.
describe('patterns.md quotes the benchmark rows benchmarks.md has', () => {
  it('each runner row is a row of the head-to-head table, cells and all', () => {
    const doc = readFileSync(path.join(pkg, 'docs', 'patterns.md'), 'utf8')
    const bench = readFileSync(path.join(pkg, 'docs', 'benchmarks.md'), 'utf8')
    const tableAt = doc.indexOf('| Runner | Fresh (cold)')
    expect(tableAt).toBeGreaterThan(0)
    const leadIn = doc.slice(doc.indexOf('## Performance'), tableAt)
    const table = doc.slice(tableAt)
    const rows = table
      .split('\n')
      .slice(2)
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(2, 5)
          .map((cell) => cell.trim()),
      )
    expect(rows.length).toBe(3)
    for (const cells of rows) {
      expect(cells.length).toBe(3)
      const row = new RegExp(
        `^\\|[^|]*\\|\\s*${cells.map((c) => c.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('\\s*\\|\\s*')}\\s*\\|`,
        'm',
      )
      const found = row.exec(bench)
      expect({ cells, onBenchmarks: found !== null }).toEqual({ cells, onBenchmarks: true })
      // And the table is attributed to the workspace it was measured on.
      // These rows are the 476-package run; the page called them the
      // 3,270-task one and cited RESULTS.md, which benchmarks.md says IS
      // the 3,270-task run — two wrong attributions in one sentence, and
      // the figures above them were right, so the row pin alone passed it
      // (item 383, 2026-09-19).
      const scales = [...bench.slice(0, found!.index).matchAll(/([\d,]+) packages/g)]
      const scale = scales[scales.length - 1]![1]!
      expect({ cells, scale, inLeadIn: leadIn.includes(scale) }).toEqual({
        cells,
        scale,
        inLeadIn: true,
      })
    }
  })
})
