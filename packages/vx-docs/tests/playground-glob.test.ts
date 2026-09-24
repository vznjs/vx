// The playground's `Bun.Glob.match` (src/playground/shim/glob.ts, a port
// of Bun's src/glob/matcher.rs) answers exactly what Bun answers. The oracle
// is the running Bun, so a Bun release that changes its matcher turns this
// red instead of silently desyncing the site's plan from the CLI's (item
// 692; design: packages/vx/docs/design/playground-spike-2026-09.md § Glob).
import { describe, expect, it } from 'bun:test'
import { globCases, mulberry32 } from './glob-fuzz.js'
import { Glob } from '../src/playground/shim/glob.js'

// Bun's match count per domain pins that the fuzz is still the table's.
const DOMAINS = [
  ['task', 'git', 16_994],
  ['task', 'any', 23_775],
  ['bun', 'git', 29_095],
  ['bun', 'any', 33_440],
] as const

interface Score {
  pairs: number
  bunMatches: number
  differs: string[]
}

// The seed, size and domain order of vx-bench's glob-equiv.ts, so these
// rows ARE the design note's table. The domains share one stream, so all
// four are scored at once and a filtered run (`-t`) still sees the same
// pairs.
let table: Score[] | undefined
function scores(): Score[] {
  if (table !== undefined) return table
  const rand = mulberry32(667)
  table = DOMAINS.map(([patterns, paths]) => {
    const score: Score = { pairs: 0, bunMatches: 0, differs: [] }
    for (const c of globCases(patterns, paths, 20_000, 25, rand)) {
      const bun = new Bun.Glob(c.pattern)
      const port = new Glob(c.pattern)
      for (const s of c.paths) {
        const want = bun.match(s)
        score.pairs++
        if (want) score.bunMatches++
        if (port.match(s) !== want) {
          score.differs.push(`${JSON.stringify(c.pattern)} ${JSON.stringify(s)} bun=${want}`)
        }
      }
    }
    return score
  })
  return table
}

// Whichever domain row runs first scores all four: 2,000,000 matches, CPU
// bound. That is 1.2 s alone here, 4.7 s with three copies on one core, and
// CI's loaded runner took 6.9 s against bun's 5 s default, so each row
// carries a budget sized for a shared machine, not for this one.
const SCORING_BUDGET_MS = 60_000

describe('the playground glob port equals Bun.Glob.match', () => {
  DOMAINS.forEach(([patterns, paths, bunMatches], i) => {
    it(
      `${patterns} globs × ${paths} paths: zero differences in 500,000 pairs`,
      () => {
        const r = scores()[i]!
        expect({ differ: r.differs.length, first: r.differs.slice(0, 10) }).toEqual({
          differ: 0,
          first: [],
        })
        expect(r.pairs).toBe(500_000)
        expect(r.bunMatches).toBe(bunMatches)
      },
      SCORING_BUDGET_MS,
    )
  })

  // Hand rows, each pinning Bun's own answer too, so a Bun that changes one
  // is named by the row and not only counted by the fuzz.
  const rows: Array<[pattern: string, path: string, bun: boolean]> = [
    // The rule-based shim before item 692 answered each of these wrong: runs
    // of `**` abutting braces or stars, `**` then `?`, the trailing-`/`
    // quirk, and `\b` (a backspace in Bun's escape table).
    ['**/**/**x', 'a/b/x', true],
    ['**/**/**x', 'a/bx', true],
    ['**/**/**x', 'a//x', true],
    ['{a,}**/**\\[', 'a/[', true],
    ['{a,}**/**\\[', 'ab/[', true],
    ['{a,}**/**\\[', '[', false],
    ['{a,}**/**x', 'ax', false],
    ['**/**?', 'a./a', true],
    ['**/*', 'a/', false],
    ['x/**/*', 'x/', false],
    ['\\b', 'b', false],
    ['\\b', '\b', true],
    // Past the depth-10 brace stack and the 10,000-branch budget Bun answers
    // no match; the shim before 692 had neither limit.
    ['{'.repeat(11) + 'a' + '}'.repeat(11), 'a', false],
    ['{a,a,a,a,a,a,a,a,a,aa}'.repeat(4) + 'b', 'aaaaaaaab', false],
    // Controls both matchers answer alike, beside each limit and quirk.
    ['{'.repeat(10) + 'a' + '}'.repeat(10), 'a', true],
    ['{a,a,a,a,a,a,a,a,a,aa}'.repeat(3) + 'b', 'aaaaaab', true],
    ['**/*', 'a', true],
    ['{a,}', '', true],
    ['a{,b}', 'a', true],
    ['\\a', 'a', true],
    ['[é-😀]', 'ÿ', true],
    ['[é-😀]', 'a', false],
    ['?', '😀', true],
    ['??', '\ud800', false],
    ['a\\', 'a', false],
    ['[a', 'a', false],
    ['!!a', 'a', true],
    ['!{a,b}', 'c', true],
  ]
  for (const [pattern, path, bun] of rows) {
    it(`${JSON.stringify(pattern)} against ${JSON.stringify(path)} is ${bun}`, () => {
      expect(new Bun.Glob(pattern).match(path)).toBe(bun)
      expect(new Glob(pattern).match(path)).toBe(bun)
    })
  }
})
