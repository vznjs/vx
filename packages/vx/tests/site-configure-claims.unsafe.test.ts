// The caching page's `vx why` verdict table and the workspace page's
// `baseBranch` default, held to the source that prints and decides them. The table
// lacked the --continue verdict, and the default omitted the trunk
// fallback #2122 added.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const DOCS = path.resolve(import.meta.dir, '../../../private/vx-docs/src/content/docs/docs')
const CACHING = readFileSync(path.join(DOCS, 'caching.mdx'), 'utf8')
const WORKSPACE = readFileSync(path.join(DOCS, 'workspace.mdx'), 'utf8')

describe('the configure pages', () => {
  it('lists every "cache key unchanged" verdict vx why prints', () => {
    const metrics = readFileSync(path.join(SRC, 'history', 'metrics.ts'), 'utf8')
    const verdicts = [...metrics.matchAll(/return [`'](cache key unchanged — [^`'$]*)/g)].map(
      (m) => m[1]!,
    )
    expect(verdicts.length).toBeGreaterThanOrEqual(7)
    expect(verdicts.filter((v) => !CACHING.includes(v))).toEqual([])
  })

  it("names a bare --affected's base branch and its default", () => {
    const row = WORKSPACE.split('\n').find((l) => l.startsWith('| `baseBranch`'))!
    for (const name of ['origin/HEAD', 'main', 'master']) expect(row).toContain(name)
    expect(row).toContain('no default')
    expect(row).not.toContain('HEAD~1')
  })
})
