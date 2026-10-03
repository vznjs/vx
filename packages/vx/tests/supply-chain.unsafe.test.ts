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

/**
 * Every line of a `run:` script that expands a value an event or a
 * dispatcher supplies (`github.event.*`, `inputs.*`, `github.head_ref`):
 * GitHub pastes it into the script before the shell parses it, so a tag
 * or input holding `$(…)` runs (L-28). Such a value reaches a script
 * through `env:` and is quoted there.
 */
function injectable(text: string): string[] {
  const bad: string[] = []
  let runIndent = -1
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line)
    if (run !== null) {
      const rest = run[2]!.trim()
      runIndent = /^[|>]-?$/.test(rest) ? run[1]!.length : -1
      if (runIndent < 0 && TAINTED.test(rest)) bad.push(rest)
      continue
    }
    if (runIndent < 0 || line.trim() === '') continue
    if (indent <= runIndent) {
      runIndent = -1
      continue
    }
    if (TAINTED.test(line)) bad.push(line.trim())
  }
  return bad
}
const TAINTED = /\$\{\{[^}]*\b(?:github\.event\.|inputs\.|github\.head_ref)/

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

  it('passes an event or input value to a script through env, never pasted in', () => {
    expect(
      files.flatMap((f) => injectable(readFileSync(f, 'utf8')).map((l) => `${rel(f)}: ${l}`)),
    ).toEqual([])
  })

  it('finds a pasted value in a block or a one-line script, not in env (the checker itself)', () => {
    expect(
      injectable(
        [
          '      - run: echo "${{ github.event.pull_request.title }}"',
          '      - name: x',
          '        env:',
          '          RAW: ${{ github.event.inputs.version || github.event.release.tag_name }}',
          '        run: |',
          '          set -e',
          '          V="${{ inputs.tag }}"',
          '          echo "$RAW ${{ steps.version.outputs.version }}"',
          '      - uses: owner/action@4d101475d8b20a2381f78447822ac1eab6504dd8',
          '        with:',
          '          ref: ${{ github.event.inputs.ref }}',
        ].join('\n'),
      ),
    ).toEqual(['echo "${{ github.event.pull_request.title }}"', 'V="${{ inputs.tag }}"'])
  })

  // A workflow without a top-level `permissions:` runs on the repository's
  // default token, which may write, and CI runs a PR's code (L-29).
  it('declares the token permissions of every workflow', () => {
    const workflows = files.filter((f) => f.includes(`${path.sep}workflows${path.sep}`))
    expect(workflows.length).toBeGreaterThan(3)
    expect(
      workflows.filter((f) => !/^permissions:/m.test(readFileSync(f, 'utf8'))).map(rel),
    ).toEqual([])
  })

  // The publish is scripts/release.ts's (`release.publish.<os>`); a workflow
  // publishes nothing itself (workflow-runner.unsafe.test.ts).
  it('publishes every npm package with provenance', () => {
    const script = readFileSync(path.join(ROOT, 'packages', 'vx', 'scripts', 'release.ts'), 'utf8')
    const publishes = [...script.matchAll(/\[npm, 'publish'[^\]]*\]/g)].map((m) => m[0])
    expect(publishes.length).toBeGreaterThan(0)
    expect(publishes.filter((p) => !p.includes("'--provenance'"))).toEqual([])
  })
})
