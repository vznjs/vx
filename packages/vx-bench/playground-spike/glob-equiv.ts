// W9 (items 676, 692): does the pure-TS matcher answer `Bun.Glob.match` exactly?
//
//   bun packages/vx-bench/playground-spike/glob-equiv.ts
//     DUMP=n          prints n differences
//     GLOB_FUZZ_N=n   patterns per domain (default 20000, × 25 paths each)
//
// Differential fuzz, the oracle being Bun itself, over the domains
// `packages/vx-docs/tests/glob-fuzz.ts` describes. Each (pattern, path)
// pair scores the site's shim (packages/vx-docs/src/playground/shim/glob.ts,
// a port of Bun's matcher) and picomatch, the usual library answer. Exits 1
// when the shim differs anywhere: since item 692 every domain is at zero,
// and `packages/vx-docs/tests/playground-glob.test.ts` holds that at the
// default size. Numbers: docs/design/playground-spike-2026-09.md § Glob.

import picomatch from 'picomatch'
import { compiledByTaskGlob, globCases, mulberry32 } from '../../vx-docs/tests/glob-fuzz.js'
import { Glob as ShimGlob } from '../../vx-docs/src/playground/shim/glob.js'

const rand = mulberry32(667)
const N = Number(process.env.GLOB_FUZZ_N ?? 20_000)

interface Score {
  pairs: number
  bunMatches: number
  shimDiffers: number
  picomatchDiffers: number
}

function run(patterns: 'task' | 'bun', paths: 'git' | 'any', n: number, per: number): Score {
  const score: Score = { pairs: 0, bunMatches: 0, shimDiffers: 0, picomatchDiffers: 0 }
  let dumped = 0
  for (const c of globCases(patterns, paths, n, per, rand)) {
    const bun = new Bun.Glob(c.pattern)
    const shim = new ShimGlob(c.pattern)
    let pm: ((s: string) => boolean) | null
    try {
      pm = picomatch(c.pattern, { dot: true, noextglob: true, strictSlashes: true })
    } catch {
      pm = null
    }
    for (const s of c.paths) {
      const want = bun.match(s)
      score.pairs++
      if (want) score.bunMatches++
      if (shim.match(s) !== want) {
        score.shimDiffers++
        if (dumped++ < Number(process.env.DUMP ?? 0)) {
          console.error(
            `${patterns}/${paths} ${JSON.stringify(c.pattern)} ${JSON.stringify(s)} bun=${want}`,
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
  taskGit: run('task', 'git', N, 25),
  taskAny: run('task', 'any', N, 25),
  bunGit: run('bun', 'git', N, 25),
  bunAny: run('bun', 'any', N, 25),
}
console.log(JSON.stringify(result, null, 2))
const differs =
  realShim +
  result.taskGit.shimDiffers +
  result.taskAny.shimDiffers +
  result.bunGit.shimDiffers +
  result.bunAny.shimDiffers
if (differs > 0) process.exit(1)
