// The repository's own supply chain, held by law (supervisor backlog):
// every third-party action runs from a full commit SHA, never a tag a
// maintainer (or whoever takes their account) can move, and every npm
// package publishes with provenance. The binaries' attestations are
// release-provenance.unsafe.test.ts.
//
// `.unsafe`: `.github/` is outside any project a sandboxed task may read.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function yamlFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p))
    else if (/\.ya?ml$/.test(name)) out.push(p)
  }
  return out
}

/** Every `uses:` ref that is neither local nor pinned to a 40-hex commit. */
function unpinned(text: string): string[] {
  const bad: string[] = []
  for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/gm)) {
    const ref = m[1]!
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref)
  }
  return bad
}

const files = yamlFiles(path.join(ROOT, '.github'))
const rel = (p: string) => path.relative(ROOT, p)

describe('the supply chain', () => {
  it('runs every third-party action from a full commit SHA', () => {
    const refs = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/gm)].map(
        (m) => m[1]!,
      ),
    )
    // The positive: the walk found third-party actions to judge.
    expect(refs.filter((r) => !r.startsWith('./')).length).toBeGreaterThan(5)
    expect(
      files.flatMap((f) => unpinned(readFileSync(f, 'utf8')).map((r) => `${rel(f)}: ${r}`)),
    ).toEqual([])
  })

  it('refuses a tag, a branch or a short SHA (the checker itself)', () => {
    expect(
      unpinned(
        [
          '      - uses: actions/checkout@v4',
          '        uses: "owner/action@main"',
          '      - uses: owner/action@abc1234',
          '      - uses: owner/action@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2',
          '      - uses: ./.github/actions/vx-runner',
        ].join('\n'),
      ),
    ).toEqual(['actions/checkout@v4', 'owner/action@main', 'owner/action@abc1234'])
  })

  it('publishes every npm package with provenance', () => {
    const publishes = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /^\s*npm publish\b/.test(l))
        .map((l) => `${rel(f)}: ${l.trim()}`),
    )
    expect(publishes.length).toBeGreaterThan(0)
    expect(publishes.filter((l) => !/--provenance\b/.test(l))).toEqual([])
  })
})
