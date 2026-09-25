// The playground's `semver.satisfies` (src/playground/shim/semver.ts) agrees
// with `Bun.semver.satisfies` on every range core's package graph passes
// it: text in node-semver's range grammar, which the graph checks before it
// asks (packages/vx/src/workspace/package-graph.ts). The oracle is the
// running Bun, so a Bun release that changes an answer turns this red
// instead of drawing the site's graph differently from the CLI's.
import { describe, expect, it } from 'bun:test'
import { SEMVER_RANGE } from '../../vx/src/workspace/package-graph.js'
import { satisfies } from '../src/playground/shim/semver.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(2026_09_24)
const int = (n: number): number => Math.floor(rand() * n)
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!

const PRERELEASES = ['0', 'alpha', 'alpha.1', 'beta.2', 'rc.1', '1', 'beta.10', 'x-y.3']
const WILDCARDS = ['x', 'X', '*']

function version(): string {
  const core = `${int(4)}.${int(4)}.${int(4)}`
  return int(3) === 0 ? `${core}-${pick(PRERELEASES)}` : core
}

const OPERATORS = ['', '', '^', '^', '~', '~>', '>', '>=', '<', '<=', '=']

// node-semver's whole range grammar at random; core's own SEMVER_RANGE
// picks the part it passes to `Bun.semver`, which is the domain the port
// must match. A leading wildcard (`x.3`) is rarer than a trailing one.
function partial(): string {
  const n = 1 + int(3)
  const wildFrom = int(8) === 0 ? int(n) : int(n + 1) + (int(2) === 0 ? n : 0)
  const parts = Array.from({ length: n }, (_, i) =>
    i >= wildFrom ? pick(WILDCARDS) : String(int(4)),
  )
  let text = parts.join('.')
  if (n === 3 && wildFrom >= 3) {
    if (int(3) === 0) text += `-${pick(PRERELEASES)}`
    if (int(8) === 0) text += '+build.5'
  }
  return (int(10) === 0 ? 'v' : '') + text
}

const space = (): string => (int(6) === 0 ? ' ' : '')

function set(): string {
  const shape = int(6)
  if (shape === 0) return `${partial()} - ${partial()}`
  const n = shape === 1 ? 2 + int(2) : 1
  const ops = shape === 1 && int(2) === 0 ? ['<', '<=', '>', '>='] : OPERATORS
  return Array.from({ length: n }, () => `${pick(ops)}${space()}${partial()}`).join(' ')
}

function range(): string {
  return Array.from({ length: 1 + int(3) }, set).join(pick([' || ', '||', '  ||  ']))
}

// The shapes a manifest actually carries, then the grammar at random.
const NAMED = [
  '^1.0.0',
  '~1.2.3',
  '1.x',
  '1.2',
  '1',
  '>=1.0.0 <2.0.0',
  '>= 1.0.0',
  '^0.1.2',
  '^0.0.3',
  '^1.2.3-beta.1',
  '~1.2.3-beta.1',
  '1.0.0 - 2.0.0',
  '1.2 - 2',
  '1.2.3-alpha - 2.0.0-rc.1',
  '^1 || ^2',
  '<2.0.0-0',
  '>=2.0.0-0',
  '=1.2.3',
  'v1.2.3',
  '*.*.*',
  'x',
  '<=1.x',
  '>1.x',
  '>1.2.x',
  '>=1.x <2',
  // Item 831's sweep: each reaches a line the random grammar rarely does.
  '1.0.0  -   2.0.0',
  '^0.0.1',
  '>=1.2.3-alpha.1',
  '<1.2.3-alpha.1',
  '<=1.2.3-alpha.1',
  '>=1.2.3-beta.2',
  '>=3.0.0-alpha <3.x',
  '3.0.0-alpha - 2',
  '>=3.1.0-alpha <3.1',
  '>=3.1.0-alpha <3.1.x',
  '>=3.0.0-alpha <=2.x',
  '>=2.2.0-alpha <=2.1',
  '2.2.0-alpha - 2.1',
  '2.2.0-alpha - 2.1.x',
  '2.2.0-alpha - 2.1.9',
]
const VERSIONS = [
  '0.0.0',
  '0.0.3',
  '0.1.2',
  '0.1.9',
  '1.0.0',
  '1.2.3',
  '1.2.3-beta.1',
  '1.2.3-beta.2',
  '1.9.9',
  '2.0.0',
  '2.0.0-rc.1',
  '2.0.0-0',
  '3.1.4',
  '0.0.2',
  '1.2.3-alpha',
  '1.2.3-alpha.1.2',
  '1.2.3-beta.10',
  '3.0.0-beta',
  '3.1.0-beta',
  '2.2.0-beta',
  // A manifest's version as written: prefixed, with build metadata,
  // padded, or no version at all.
  'v1.2.3',
  '=1.2.3',
  '1.2.3+build.5',
  ' 1.2.3 ',
  'latest',
  '1.2',
]

describe('the playground semver', () => {
  it('agrees with Bun.semver.satisfies on the ranges a manifest carries', () => {
    expect(NAMED.filter((r) => !SEMVER_RANGE.test(r))).toEqual([])
    const differ: string[] = []
    for (const r of NAMED) {
      for (const ver of VERSIONS) {
        if (satisfies(ver, r) !== Bun.semver.satisfies(ver, r)) differ.push(`${ver} ${r}`)
      }
    }
    expect(differ).toEqual([])
  })

  it('agrees with Bun.semver.satisfies on every range core admits', () => {
    const differ: string[] = []
    let admitted = 0
    let rejected = 0
    let yes = 0
    for (let i = 0; i < 20_000; i++) {
      const r = range()
      if (!SEMVER_RANGE.test(r)) {
        rejected++
        continue
      }
      admitted++
      for (let k = 0; k < 4; k++) {
        const ver = version()
        const want = Bun.semver.satisfies(ver, r)
        if (want) yes++
        if (satisfies(ver, r) !== want) differ.push(`${ver} ${JSON.stringify(r)}`)
      }
    }
    expect(differ.slice(0, 20)).toEqual([])
    // The generator reaches both sides of core's grammar, and both answers
    // occur often enough that agreeing is not agreeing on one.
    expect(admitted).toBeGreaterThan(4000)
    expect(rejected).toBeGreaterThan(1000)
    expect(yes).toBeGreaterThan(admitted / 4)
    expect(yes).toBeLessThan(admitted * 3)
  })
})
