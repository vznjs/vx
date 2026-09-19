// architecture.md is the design map a reader takes on trust, and by
// 2026-09-16 (item 294) it quoted TELEMETRY_SCHEMA_VERSION 1 of 2, listed
// two orchestrator files that do not exist and missed seventeen that do,
// named `mcp` as a core verb and left out `why` and `last`, and tabulated
// twelve of the `runs` table's twenty-one columns. Each list in prose that
// has a source is held to it here.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { TELEMETRY_SCHEMA_VERSION } from '../src/orchestrator/index.js'

const pkg = path.resolve(import.meta.dir, '..')
const doc = readFileSync(path.join(pkg, 'docs', 'architecture.md'), 'utf8')

function section(heading: string): string {
  const m = new RegExp(
    `^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3} )`,
    'm',
  ).exec(doc)
  expect(m).not.toBeNull()
  return m![1]!
}

describe('architecture.md follows the source it describes', () => {
  it("the orchestrator's file inventory names exactly src/orchestrator/*.ts", () => {
    const named = new Set(
      [...section("### The orchestrator's file inventory").matchAll(/`([a-z-]+)\.ts`/g)].map(
        (m) => m[1]!,
      ),
    )
    const files = readdirSync(path.join(pkg, 'src', 'orchestrator'))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
    expect([...named].sort()).toEqual(files.sort())
  })

  it('quotes the current TELEMETRY_SCHEMA_VERSION, as does modules/telemetry.md', () => {
    for (const file of ['architecture.md', 'modules/telemetry.md']) {
      const text = readFileSync(path.join(pkg, 'docs', file), 'utf8')
      const m = /`TELEMETRY_SCHEMA_VERSION = (\d+)`/.exec(text)
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBe(TELEMETRY_SCHEMA_VERSION)
    }
  })

  it('the dispatch sentence names every verb cli/index.ts switches on', () => {
    const src = readFileSync(path.join(pkg, 'src', 'cli', 'index.ts'), 'utf8')
    const cases = new Set([...src.matchAll(/^\s*case '([a-z]+)':/gm)].map((m) => m[1]!))
    const sentence = /dispatches by subcommand:([\s\S]*?);/.exec(doc)
    expect(sentence).not.toBeNull()
    const named = new Set([...sentence![1]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!))
    expect([...named].sort()).toEqual([...cases].sort())
  })

  it('the runs-column table lists every column of the runs table (rowid aside)', () => {
    const src = readFileSync(path.join(pkg, 'src', 'cache', 'cache.ts'), 'utf8')
    const block = /CREATE TABLE IF NOT EXISTS runs \(([\s\S]*?)\n\s*\)/.exec(src)
    expect(block).not.toBeNull()
    const columns = block![1]!
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+\s/.test(l))
      .map((l) => l.split(/\s+/)[0]!)
      .filter((c) => c !== 'id')
    const table = section('## Run-history analytics').split('The `invocations` header row')[0]!
    const documented = new Set<string>()
    for (const line of table.split('\n')) {
      if (!line.startsWith('| `')) continue
      const cell = line.split('|')[1]!
      for (const span of cell.matchAll(/`([^`]+)`/g)) {
        for (const c of span[1]!.split(',')) documented.add(c.trim())
      }
    }
    expect([...documented].sort()).toEqual([...new Set(columns)].sort())
  })

  it('states the runtime size of the public API', async () => {
    const api = await import('../src/index.js')
    const m = /public API \((\d+) runtime symbols/.exec(doc)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(Object.keys(api).length)
  })
})

// "Core is organised as eight modules plus three root files" — two counts in
// words above a table of eight rows, and the same split `module-boundaries`
// enforces: a module is a directory with an index.ts contract, or a root file
// with no internals to hide. Nothing held either number, and a count in words
// is the first thing to rot when a module lands (item 355's "five layers"
// above a six-row table, one page over). Item 363, 2026-09-19.
describe('architecture.md counts the modules that are on disk', () => {
  it('eight modules and three root files, and the table has a row each', async () => {
    const src = path.join(import.meta.dir, '..', 'src')
    const entries = readdirSync(src, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    const roots = entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name.replace(/\.ts$/, ''))
    // `config` is the root file the page counts as a module: it is the user
    // schema every other module consumes, not plumbing like bin/index/version.
    const modules = [...dirs, 'config'].sort()
    expect(modules.length).toBe(8)
    const doc = await Bun.file(path.join(import.meta.dir, '..', 'docs', 'architecture.md')).text()
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
    expect(doc).toContain(
      `Core is organised as **${WORDS[modules.length]} modules** plus ` +
        `${WORDS[roots.length - 1]} root files.`,
    )
    // The table under it names each one, and nothing else.
    const start = doc.indexOf('| Module         | Form')
    expect(start).toBeGreaterThan(-1)
    const table = doc.slice(start, doc.indexOf('\n\n', start))
    const named = [...table.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1] as string)
    expect(named.sort()).toEqual(modules)
  })
})
