// A merge conflict resolved by committing both sides left its markers in
// docs/modules/metrics.md, and nothing read them (F-60). A line that opens
// with a conflict marker is refused in every file of this package.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { relPosix } from '../src/util/index.js'

const ROOT = path.resolve(import.meta.dir, '..')
const MARKER = new RegExp(`^(${'<'.repeat(7)}|${'>'.repeat(7)})( |$)`, 'm')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.(ts|md|json|cjs|mjs)$/.test(e.name) ? [p] : []
  })
}

it('no file holds a merge-conflict marker', () => {
  const all = files(ROOT)
  expect(all.length).toBeGreaterThan(100)
  const marked = all.filter((f) => MARKER.test(readFileSync(f, 'utf8')))
  expect(marked.map((f) => relPosix(ROOT, f))).toEqual([])
})
