// The glob fuzz's generator, shared by the scoreboard (`glob-equiv.ts`) and
// the parity row (`tests/glob-port.test.ts`), so the row fuzzes exactly the
// domains the design note reports.
//
// Patterns:
//   task — vx's task-glob alphabet (`*`, `**`, `?`, braces, `\`, and LITERAL
//          brackets since item 667), compiled by core's own `taskGlob` so the
//          escaping under test is core's, not a copy;
//   bun  — Bun's whole alphabet (classes, negation, dangling escapes and
//          braces), the globs vx does not own.
// Paths:
//   git  — what the planner matches: a git-reported relative path, every
//          segment non-empty, no leading or trailing `/`;
//   any  — any string over the alphabet, empty segments included.

import { taskGlob } from '../../vx/src/util/paths.js'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
const ANY_CHARS = [...SEGMENT_CHARS, '/', '/']

// The string `taskGlob` hands to `new Bun.Glob`, captured by swapping the
// constructor for one call: the matcher under test must see exactly what
// Bun sees.
export function compiledByTaskGlob(pattern: string): string {
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

/**
 * `n` patterns from one alphabet, each with `per` paths from one domain,
 * drawn from `rand` in a fixed order, so one seed reproduces the table.
 */
export function* globCases(
  patterns: 'task' | 'bun',
  paths: 'git' | 'any',
  n: number,
  per: number,
  rand: () => number,
): Generator<{ pattern: string; paths: string[] }> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const segment = (): string => {
    const k = 1 + Math.floor(rand() * 3)
    let s = ''
    for (let i = 0; i < k; i++) s += pick(SEGMENT_CHARS)
    return s
  }
  const gitPath = (): string =>
    Array.from({ length: 1 + Math.floor(rand() * 3) }, segment).join('/')
  const anyPath = (): string => {
    const k = Math.floor(rand() * 7)
    let s = ''
    for (let i = 0; i < k; i++) s += pick(ANY_CHARS)
    return s
  }
  const tokens = patterns === 'task' ? TASK_TOKENS : BUN_TOKENS
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rand() * 6)
    let raw = ''
    for (let t = 0; t < len; t++) raw += pick(tokens)
    // vx strips one leading `!` (the negation) before a task glob is compiled.
    if (patterns === 'task' && raw.startsWith('!')) raw = raw.slice(1)
    const pattern = patterns === 'task' ? compiledByTaskGlob(raw) : raw
    const out: string[] = []
    for (let k = 0; k < per; k++) out.push(paths === 'git' ? gitPath() : anyPath())
    yield { pattern, paths: out }
  }
}
