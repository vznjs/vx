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
// until item 353 (2026-09-16): patterns.md's citations had already rotted
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
