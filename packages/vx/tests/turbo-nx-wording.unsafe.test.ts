// Owner, 2026-10-02: vx does not work in, run or speed up a Turbo or Nx
// repo; `vx init` and `@vzn/vx-migrate` are a temporary start toward
// native config. Every page a user reads (the READMEs, docs/ as the site
// imports it, the site's own pages and components) is held to that
// wording. STATUS.md (the maintainers' handoff, which states the rule),
// history/ and design/ (dated records) are not user pages.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const TOOL = '(?:Turbo(?:repo)?|Nx)(?: or (?:Turbo(?:repo)?|Nx))? (?:repo|workspace|monorepo)s?\\b'
const CLAIMS = [
  new RegExp(
    `\\b(?:works?|runs?|running|speeds? up)\\b[^.\\n]{0,40}\\b(?:an?|your|any|existing|the) ${TOOL}`,
    'gi',
  ),
  new RegExp(`\\b${TOOL}[^.\\n]{0,30}\\bunchanged\\b`, 'gi'),
  new RegExp(`\\bunchanged\\b[^.\\n]{0,15}\\b${TOOL}`, 'gi'),
]
const PAGES = [
  'README.md',
  'CONTRIBUTING.md',
  'packages/*/README.md',
  'examples/*/README.md',
  'packages/vx/docs/**/*.md',
  'packages/vx-docs/src/**/*.{md,mdx,astro,ts}',
]

function pages(): string[] {
  const out: string[] = []
  for (const p of PAGES)
    for (const f of new Bun.Glob(p).scanSync(ROOT))
      if (!/(^|\/)(history|design|node_modules)\/|docs\/STATUS\.md$/.test(f)) out.push(f)
  return out
}

/** Each claim a text makes, as `file: match`. */
function claims(file: string, text: string): string[] {
  return CLAIMS.flatMap((re) => [...text.matchAll(re)].map((m) => `${file}: ${m[0]}`))
}

describe('no page says vx works in a Turbo or Nx repo', () => {
  it('every user page is clear of the claim', () => {
    const files = pages()
    expect(files.length).toBeGreaterThan(200)
    expect(files.flatMap((f) => claims(f, readFileSync(path.join(ROOT, f), 'utf8')))).toEqual([])
  })

  it('the patterns catch each spelling of the claim', () => {
    expect(
      [
        'vx runs your Nx workspace as it is.',
        'It works in any Turbo or Nx repo.',
        '`turbo()` runs a Turborepo monorepo.',
        'Keep the Nx repo unchanged.',
        'Bring a Turbo repo unchanged.',
        'An unchanged Nx workspace builds.',
        'vx speeds up an Nx repo.',
      ].map((t) => claims('t', t).length),
    ).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(claims('t', 'Move a Turborepo or Nx repo to native vx config.')).toEqual([])
  })
})
