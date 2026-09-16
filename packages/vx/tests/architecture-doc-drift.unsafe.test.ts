// The out-of-project half of architecture-doc-drift.test.ts: the package
// table names the siblings under packages/, which a sandboxed shard cannot
// read. It listed six of nine on 2026-09-16 (item 294).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const pkg = path.resolve(import.meta.dir, '..')
const repo = path.resolve(pkg, '..', '..')

describe('architecture.md § Repository shape follows packages/', () => {
  it('has one row per package directory, core included', () => {
    const doc = readFileSync(path.join(pkg, 'docs', 'architecture.md'), 'utf8')
    const rows = [...doc.matchAll(/^\| `packages\/([a-z-]+)`\s+\|/gm)].map((m) => m[1]!)
    const dirs = readdirSync(path.join(repo, 'packages')).filter((d) =>
      existsSync(path.join(repo, 'packages', d, 'package.json')),
    )
    expect(rows.sort()).toEqual(dirs.sort())
  })
})
