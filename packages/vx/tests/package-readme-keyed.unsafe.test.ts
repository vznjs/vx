// A package test that reads its README (a sample it holds to the code)
// left the README out of the task's inputs, so an edit to the sample
// replayed a pass (vx-history, 2026-11-25). Each such task keys it.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
// The package's own README, one directory up from its tests.
const READS = /'\.\.\/README\.md'|'\.\.', 'README\.md'/

function readsReadme(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (
      e.isDirectory()
        ? readsReadme(p)
        : /\.[cm]?[jt]s$/.test(e.name) && READS.test(readFileSync(p, 'utf8'))
    )
      return true
  }
  return false
}

it('every cached bun test task of a package whose tests read its README keys it', () => {
  const unkeyed: string[] = []
  for (const top of ['packages', 'private']) {
    for (const name of readdirSync(path.join(REPO, top))) {
      const dir = path.join(REPO, top, name)
      let reads: boolean
      try {
        reads = readsReadme(path.join(dir, 'tests'))
      } catch {
        continue
      }
      if (!reads) continue
      const lock = JSON.parse(readFileSync(path.join(dir, 'vx.lock.json'), 'utf8')) as {
        tasks: Record<
          string,
          { cache?: boolean; exec?: { command?: string }; inputs?: { files?: string[] } }
        >
      }
      for (const [task, t] of Object.entries(lock.tasks)) {
        const files = t.inputs?.files ?? []
        if (t.cache !== true || !files.includes('tests/**')) continue
        if (!/\bbun test\b/.test(t.exec?.command ?? '')) continue
        if (!files.some((f) => f === 'README.md' || f === '*.md' || f === '**/*'))
          unkeyed.push(`${top}/${name}#${task}`)
      }
    }
  }
  expect(unkeyed).toEqual([])
})
