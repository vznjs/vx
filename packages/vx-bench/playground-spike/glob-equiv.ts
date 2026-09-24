// W9 spike (item 676): does a pure-TS matcher answer `Bun.Glob.match` exactly?
//
//   bun packages/vx-bench/playground-spike/glob-equiv.ts        (DUMP=n prints n diffs)
//
// Differential fuzz, the oracle being Bun itself. Patterns:
//   task — vx's task-glob alphabet (`*`, `**`, `?`, braces, `\`, and LITERAL
//          brackets since item 667), compiled by core's own `taskGlob` so the
//          escaping under test is core's, not a copy;
//   bun  — Bun's whole alphabet (classes, negation, dangling escapes and
//          braces), the globs vx does not own.
// Paths:
//   git  — what the planner matches: a git-reported relative path, every
//          segment non-empty, no leading or trailing `/`;
//   any  — any string over the alphabet, empty segments included.
// Each (pattern, path) pair scores the shim (shim/glob.ts) and picomatch, the
// usual library answer. Exits 1 when the shim differs on a realistic glob;
// the fuzz domains are a scoreboard (spike result: not yet zero — see
// docs/design/playground-spike-2026-09.md for what zero needs).

import picomatch from 'picomatch'
import { taskGlob } from '../../vx/src/util/paths.js'
import { Glob as ShimGlob } from './shim/glob.js'

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
const rand = mulberry32(667)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

const TASK_TOKENS = [
  'a',
  'b',
  '.',
  '/',
  '/',
  '*',
  '**',
  '**/',
  '/**',
  '?',
  '{a,b}',
  '{a,}',
  '{*,*/*}',
  '[',
  ']',
  '[a]',
  'x',
  '\\*',
  ',',
  '-',
  '!',
]
const BUN_TOKENS = [...TASK_TOKENS, '[!a]', '[^b]', '[a-c]', '{', '}', '\\', '[]]', '{a,{b,.}}']
const SEGMENT_CHARS = ['a', 'b', 'x', '.', '[', ']', '*', '{', '}', ',', '!', 'é']

function patternOf(tokens: readonly string[]): string {
  const n = 1 + Math.floor(rand() * 6)
  let p = ''
  for (let i = 0; i < n; i++) p += pick(tokens)
  return p
}

function segment(): string {
  const n = 1 + Math.floor(rand() * 3)
  let s = ''
  for (let i = 0; i < n; i++) s += pick(SEGMENT_CHARS)
  return s
}

function gitPath(): string {
  const n = 1 + Math.floor(rand() * 3)
  return Array.from({ length: n }, segment).join('/')
}

function anyPath(): string {
  const n = Math.floor(rand() * 7)
  let s = ''
  for (let i = 0; i < n; i++) s += pick([...SEGMENT_CHARS, '/', '/'])
  return s
}

// The string `taskGlob` hands to `new Bun.Glob`, captured by swapping the
// constructor for one call: the shim must see exactly what Bun sees.
function compiledByTaskGlob(pattern: string): string {
  const real = Bun.Glob
  let seen = ''
  ;(Bun as { Glob: unknown }).Glob = class {
    constructor(p: string) {
      seen = p
    }
  }
  try {
    taskGlob(pattern)
  } finally {
    ;(Bun as { Glob: unknown }).Glob = real
  }
  return seen
}

interface Score {
  pairs: number
  bunMatches: number
  shimDiffers: number
  picomatchDiffers: number
}

function run(patterns: 'task' | 'bun', paths: 'git' | 'any', n: number, per: number): Score {
  const score: Score = { pairs: 0, bunMatches: 0, shimDiffers: 0, picomatchDiffers: 0 }
  let dumped = 0
  for (let i = 0; i < n; i++) {
    let raw = patternOf(patterns === 'task' ? TASK_TOKENS : BUN_TOKENS)
    // vx strips one leading `!` (the negation) before a task glob is compiled.
    if (patterns === 'task' && raw.startsWith('!')) raw = raw.slice(1)
    const compiled = patterns === 'task' ? compiledByTaskGlob(raw) : raw
    const bun = new Bun.Glob(compiled)
    const shim = new ShimGlob(compiled)
    let pm: ((s: string) => boolean) | null
    try {
      pm = picomatch(compiled, { dot: true, noextglob: true, strictSlashes: true })
    } catch {
      pm = null
    }
    for (let k = 0; k < per; k++) {
      const s = paths === 'git' ? gitPath() : anyPath()
      const want = bun.match(s)
      score.pairs++
      if (want) score.bunMatches++
      if (shim.match(s) !== want) {
        score.shimDiffers++
        if (dumped++ < Number(process.env.DUMP ?? 0)) {
          console.error(
            `${patterns}/${paths} ${JSON.stringify(compiled)} ${JSON.stringify(s)} bun=${want}`,
          )
        }
      }
      if ((pm === null ? false : pm(s)) !== want) score.picomatchDiffers++
    }
  }
  return score
}

// Realistic globs over realistic paths: the shapes vx configs declare.
const REAL_GLOBS = [
  'src/**/*.ts',
  '**/*',
  'dist/**',
  'app/[id]/**',
  '*.{ts,tsx}',
  '**/*.test.ts',
  'tsconfig*.json',
  'src/',
  'package.json',
  '**/node_modules/**',
  '**/.vx/**',
  '**/*.tsbuildinfo',
  'dist',
  'dist/**/*.{js,d.ts}',
  '{src,test}/**',
]
const REAL_PATHS = [
  'src/index.ts',
  'src/a/b.ts',
  'src/a/b.test.ts',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/x/y.js',
  'app/[id]/page.tsx',
  'app/i/page.tsx',
  'x.ts',
  'x.tsx',
  '.eslintrc',
  'tsconfig.json',
  'tsconfig.build.json',
  'package.json',
  'node_modules/a/index.js',
  'a/node_modules/b',
  '.vx/cache/db',
  'tsconfig.tsbuildinfo',
  'test/a.ts',
  'dist',
  'src',
]
let realShim = 0
let realPicomatch = 0
for (const g of REAL_GLOBS) {
  const compiled = compiledByTaskGlob(g)
  const bun = new Bun.Glob(compiled)
  const shim = new ShimGlob(compiled)
  const pm = picomatch(compiled, { dot: true, noextglob: true, strictSlashes: true })
  for (const s of REAL_PATHS) {
    if (bun.match(s) !== shim.match(s)) realShim++
    if (bun.match(s) !== pm(s)) realPicomatch++
  }
}

const result = {
  bun: Bun.version,
  real: {
    pairs: REAL_GLOBS.length * REAL_PATHS.length,
    shimDiffers: realShim,
    picomatchDiffers: realPicomatch,
  },
  taskGit: run('task', 'git', 20_000, 25),
  taskAny: run('task', 'any', 20_000, 25),
  bunGit: run('bun', 'git', 20_000, 25),
  bunAny: run('bun', 'any', 20_000, 25),
}
console.log(JSON.stringify(result, null, 2))
if (realShim > 0) process.exit(1)
