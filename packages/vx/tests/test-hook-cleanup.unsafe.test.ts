// No beforeEach or beforeAll in any package returns a function to clean up
// after it: Bun ignores what a hook returns (vitest runs it). big-inputs'
// returned `rm` never ran, and each test left a 600 MiB `vx-reapi-big-*`
// in TMPDIR until the disk filled (2026-11-24). Clean up in afterEach or
// afterAll. Unsafe: it reads every package.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

it('no before hook returns a cleanup function', () => {
  const files = [
    ...new Bun.Glob('{packages,private}/*/tests/**/*.test.ts').scanSync({ cwd: repo }),
  ].filter((f) => !f.includes('node_modules'))
  expect(files.length).toBeGreaterThan(1000)
  const returning: string[] = []
  for (const f of files) {
    const text = readFileSync(path.join(repo, f), 'utf8')
    // A hook's body up to its own closing line, or a hook that is an arrow to an arrow.
    for (const m of text.matchAll(
      /^(\s*)before(?:Each|All)\((?:async )?\([^)]*\) => (?:\{\n([\s\S]*?)\n\1\}|(?:async )?\([^)]*\) =>)/gm,
    )) {
      const body = m[2]
      if (body === undefined || new RegExp(`^${m[1]}  return (?:async )?\\(`, 'm').test(body))
        returning.push(`${f}:${text.slice(0, m.index).split('\n').length}`)
    }
  }
  expect(returning).toEqual([])
})
