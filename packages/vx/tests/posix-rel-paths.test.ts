// A row that compares `path.relative(...)` against a `/`-spelled path
// asserts POSIX separators: on Windows the same code answers `dist\a.js`,
// and the row fails for the test, not for vx (O-11). A row compares
// `relPosix`, the spelling vx itself keys and stores.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const TESTS = import.meta.dir
const NATIVE_REL_MAP = /\.map\(\(\w+\) => path\.relative\(/

describe('no row compares a native relative path', () => {
  it('the pattern catches the shape it names', () => {
    // CONTROL: a pattern that matches nothing passes the law.
    expect(NATIVE_REL_MAP.test('files.map((f) => path.relative(root, f))')).toBe(true)
    expect(NATIVE_REL_MAP.test('files.map((f) => relPosix(root, f))')).toBe(false)
  })

  it('no test maps paths through path.relative', () => {
    const found: string[] = []
    let scanned = 0
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: TESTS })) {
      scanned++
      if (rel.endsWith('posix-rel-paths.test.ts')) continue
      if (NATIVE_REL_MAP.test(readFileSync(path.join(TESTS, rel), 'utf8'))) {
        found.push(rel.split(path.sep).join('/'))
      }
    }
    expect(scanned).toBeGreaterThan(300)
    expect(found).toEqual([])
  })
})
