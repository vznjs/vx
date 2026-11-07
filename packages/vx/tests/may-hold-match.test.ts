// `mayHoldMatch` is asked of every project path no input glob takes, and
// scanned every glob prefix for each: 8,000 globs over 200,000 files was
// 76 s of key computation, paid again after any edit in the project. It now
// walks the path's own `/`s through a map. It decides which linked
// directories are hashed, so its verdict is held to the scan's on random
// glob sets and paths.
import { describe, expect, it } from 'bun:test'
import { holdReach, mayHoldMatch } from '../src/cache/inputs.js'
import { cpuClock } from './helpers/cpu-clock.js'

/** The scan it replaced, verbatim: the oracle. */
function scan(positive: readonly string[]): (rel: string) => boolean {
  const reach = holdReach(positive)
  return (rel) => {
    let depth: number | undefined
    for (const r of reach) {
      if (!rel.startsWith(r.prefix) || rel.length === r.prefix.length) continue
      if (r.deep || (depth ??= rel.split('/').length) < r.depth) return true
    }
    return false
  }
}

// A seeded LCG so a failure replays.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const DIRS = ['src', 'lib', 'a', 'b', '.hidden', 'd1', 'node_modules', 'x y']
const GLOB_SEGMENTS = [
  ...DIRS,
  '**',
  '*',
  '*.ts',
  '.*',
  'f?.js',
  '{a,b}',
  '{src,lib/d1}',
  '{,a/}b',
  '[ab]',
  'x.ts',
]
const FILES = ['x.ts', 'f1.js', '.env', 'index.ts', 'a', 'b', 'README']

describe('mayHoldMatch', () => {
  it('answers as the prefix scan did on random globs and paths', () => {
    const next = rng(5147)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
    let held = 0
    let total = 0
    for (let round = 0; round < 300; round++) {
      const globs: string[] = []
      const n = 1 + Math.floor(next() * 6)
      for (let g = 0; g < n; g++) {
        const segs = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(GLOB_SEGMENTS))
        let glob = segs.join('/')
        if (next() < 0.1) glob += '/'
        if (next() < 0.1) glob = `./${glob}`
        globs.push(glob)
      }
      const fast = mayHoldMatch(globs)
      const slow = scan(globs)
      for (let p = 0; p < 60; p++) {
        const segs = Array.from({ length: Math.floor(next() * 5) }, () => pick(DIRS))
        if (next() < 0.8) segs.push(pick(FILES))
        let rel = segs.join('/')
        if (next() < 0.05) rel += '/'
        const want = slow(rel)
        expect({ globs, rel, holds: fast(rel) }).toEqual({ globs, rel, holds: want })
        total++
        if (want) held++
      }
    }
    // Both verdicts are exercised, not one answer throughout.
    expect(held).toBeGreaterThan(total / 10)
    expect(held).toBeLessThan(total - total / 10)
  })

  it('holds a path below a fixed prefix by depth, any depth under `**`', () => {
    const may = mayHoldMatch(['src/*/*.ts', 'lib/**', 'one.ts', '{a,b}/c/*/*'])
    expect(may('src/v')).toBe(true)
    expect(may('src/v/w.ts')).toBe(false)
    expect(may('lib/v/w/z')).toBe(true)
    expect(may('lib')).toBe(false)
    expect(may('one.ts/x')).toBe(true)
    expect(may('b/c/d')).toBe(true)
    expect(may('b/c/d/e')).toBe(false)
    expect(may('other/x')).toBe(false)
    expect(may('')).toBe(false)
    expect(mayHoldMatch(['*.ts'])('x')).toBe(false)
    expect(mayHoldMatch(['**/*.ts'])('x/y/z')).toBe(true)
  })

  it('costs the path depth, not the glob count', () => {
    const globs = Array.from({ length: 4000 }, (_, i) => `src/d${i}/x/*.ts`)
    const paths = Array.from({ length: 50_000 }, (_, i) => `src/d${i % 4000}/y/f${i}.ts`)
    const may = mayHoldMatch(globs)
    const cpu = cpuClock()
    let held = 0
    for (const rel of paths) if (may(rel)) held++
    // The scan took ~1.5 s of CPU here; the walk takes a few ms.
    expect(cpu()).toBeLessThan(400)
    expect(held).toBe(0)
  })
})
