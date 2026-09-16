// A module page's `Public surface` block declares an interface's fields as
// well as its name; the surface law (module-surface-drift.test.ts) holds
// the names only. scheduler.md's TaskOutcome had twelve of the interface's
// twenty-three fields, inputs.md's ResolveInputsArgs six of eleven and
// cli-cache.md's PruneArgs three of five (item 314, 2026-09-16). Here the
// block's field list is the source's, and a quoted constant or regex is
// the source's too.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8')

/** Top-level field names of `interface <name> {…}` in a doc block or a source file. */
function interfaceFields(text: string, name: string): string[] {
  const open = `interface ${name} {`
  const start = text.indexOf(open)
  expect(start).toBeGreaterThan(-1)
  const out: string[] = []
  let depth = 0
  let inComment = false
  for (const raw of text.slice(start + open.length).split('\n')) {
    let line = raw
    if (inComment) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      inComment = false
      line = line.slice(end + 2)
    }
    line = line.replace(/\/\/.*$/, '')
    const block = line.indexOf('/*')
    if (block !== -1) {
      const end = line.indexOf('*/', block)
      if (end === -1) {
        inComment = true
        line = line.slice(0, block)
      } else line = line.slice(0, block) + line.slice(end + 2)
    }
    if (depth === 0) {
      const m = /^\s*(\w+)\??:/.exec(line)
      if (m) out.push(m[1]!)
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') {
        if (depth === 0) return out
        depth--
      }
    }
  }
  return out
}

const SHAPES: ReadonlyArray<[page: string, source: string, name: string]> = [
  ['scheduler', 'graph/scheduler.ts', 'TaskOutcome'],
  ['scheduler', 'graph/scheduler.ts', 'ScheduleOptions'],
  ['inputs', 'cache/inputs.ts', 'ResolvedInputs'],
  ['inputs', 'cache/inputs.ts', 'ResolveInputsArgs'],
  ['cli-cache', 'cli/cache.ts', 'PruneArgs'],
  ['task-hash', 'orchestrator/task-hash.ts', 'HashCache'],
  ['task-hash', 'orchestrator/task-hash.ts', 'ComputeHashArgs'],
  ['prepare', 'orchestrator/prepare.ts', 'PreparedRun'],
]

describe('a module page declares an interface with the fields the module has', () => {
  for (const [page, source, name] of SHAPES) {
    it(`docs/modules/${page}.md's ${name} is src/${source}'s`, () => {
      const doc = interfaceFields(read(`docs/modules/${page}.md`), name)
      const src = interfaceFields(read(`src/${source}`), name)
      expect(src.length).toBeGreaterThan(2)
      expect(doc).toEqual(src)
    })
  }
})

describe('a module page quotes a constant or a regex the module has', () => {
  it("inputs.md's always-ignored list is ALWAYS_IGNORE", () => {
    const src = read('src/cache/inputs.ts')
    const arr = /const ALWAYS_IGNORE = \[([\s\S]*?)\n\]/.exec(src)
    expect(arr).not.toBeNull()
    const constant = [...arr![1]!.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    const doc = read('docs/modules/inputs.md')
    const rule = /\*\*Always-ignored\*\* — hard-coded([\s\S]*?)— applied/.exec(doc)
    expect(rule).not.toBeNull()
    expect([...rule![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)).toEqual(constant)
  })

  it("cli-cache.md's two regexes are parseDuration's and parseSize's", () => {
    const doc = read('docs/modules/cli-cache.md')
    const quoted = [...doc.matchAll(/```\n(\/[^\n]+\/i?)\n```/g)].map((m) => m[1]!)
    expect(quoted).toHaveLength(2)
    const duration = /export function parseDuration[\s\S]*?input\.match\((\/.*\/i?)\)$/m.exec(
      read('src/cli/cache.ts'),
    )
    const size = /export function parseSize[\s\S]*?input\.match\((\/.*\/i?)\)$/m.exec(
      read('src/util/size.ts'),
    )
    expect(quoted).toEqual([duration![1]!, size![1]!])
  })
})

describe('a module page lists the functions the module exports', () => {
  it("metrics.md's signature block names every exported function, and counts them", () => {
    const src = read('src/orchestrator/metrics.ts')
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!)
    const doc = read('docs/modules/metrics.md')
    const block = /```ts\n([\s\S]*?)```/.exec(doc)
    expect(block).not.toBeNull()
    const named = [...block![1]!.matchAll(/^(\w+)\(db/gm)].map((m) => m[1]!)
    expect([...named].sort()).toEqual([...exported].sort())
    const WORDS = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ]
    expect(doc).toContain(`the same ${WORDS[exported.length]} signatures`)
  })
})
