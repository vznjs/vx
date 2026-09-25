// A doc comment describes the declaration under it; a doc block directly
// followed by another doc block describes nothing — a helper (with its
// own doc) was inserted between a doc and the thing it documents, and
// editors and the type checker attached the orphan to the wrong one. 26
// such pairs had gathered across the packages by 2026-09-25 (item 761),
// among them `runGraph`'s, `taskEnv`'s and `CacheLayer`'s. Unsafe: it
// reads every package's `src/`.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')

/** `file:line` of each doc block that ends where another begins. */
function orphanedDocs(): string[] {
  const found: string[] = []
  for (const rel of new Bun.Glob('*/src/**/*.ts').scanSync({ cwd: PACKAGES })) {
    const lines = readFileSync(path.join(PACKAGES, rel), 'utf8').split('\n')
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i]!.trim().endsWith('*/') && lines[i + 1]!.trim().startsWith('/**')) {
        found.push(`${rel.split(path.sep).join('/')}:${i + 1}`)
      }
    }
  }
  return found.sort()
}

describe('every doc comment sits on the declaration it describes', () => {
  it('no doc block is followed directly by another', () => {
    expect(orphanedDocs()).toEqual([])
  })
})
