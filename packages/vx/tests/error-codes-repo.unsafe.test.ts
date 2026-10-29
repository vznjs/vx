// The error-code contract across the repo: a plugin that throws a core
// code (`VX_E_…`) answers with core's docs link, so the code has a section
// of cli.md; and a page that tells an agent to branch on a code names one
// that exists. error-codes.test.ts holds core's own source to the same
// headings. Unsafe: it reads every package and the site.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

function tracked(filter: (f: string) => boolean): string[] {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repo })
  return ls.stdout.toString().split('\0').filter(filter)
}

const headed = new Set(
  [
    ...readFileSync(path.join(repo, 'packages/vx/docs/cli.md'), 'utf8').matchAll(
      /^#### `(VX_E_[A-Z_]+)`$/gm,
    ),
  ].map((m) => m[1]!),
)

function codesIn(files: string[], quoted: RegExp): Map<string, string[]> {
  const where = new Map<string, string[]>()
  for (const f of files) {
    for (const m of readFileSync(path.join(repo, f), 'utf8').matchAll(quoted)) {
      where.set(m[1]!, [...(where.get(m[1]!) ?? []), f])
    }
  }
  return where
}

describe('every VX_E_ code outside core has its section in cli.md', () => {
  it("a plugin's source throws only codes cli.md documents", () => {
    const files = tracked(
      (f) => /^packages\/(?!vx\/)[^/]+\/src\/.*\.ts$/.test(f) && !f.endsWith('.d.ts'),
    )
    const thrown = codesIn(files, /['"`](VX_E_[A-Z_]+)['"`]/g)
    // CONTROL: vx-migrate refuses a directory with no workspace by core's code.
    expect(thrown.has('VX_E_NO_WORKSPACE')).toBe(true)
    expect([...thrown].filter(([code]) => !headed.has(code))).toEqual([])
  })

  // Release notes and blog posts are history: a code they name may be gone.
  it('a page, README or skill names only codes that exist', () => {
    const files = tracked(
      (f) =>
        /\.(?:md|mdx)$/.test(f) &&
        !/\/(?:history|releases|blog)\//.test(f) &&
        !f.startsWith('packages/vx/docs/cli.md') &&
        !f.includes('CHANGELOG') &&
        !f.startsWith('.changeset/'),
    )
    const named = codesIn(files, /\b(VX_E_[A-Z][A-Z_]*[A-Z])\b/g)
    expect(named.size).toBeGreaterThan(3)
    expect([...named].filter(([code]) => !headed.has(code))).toEqual([])
  })
})
