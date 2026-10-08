// Seeded random `cache.inputs.files` declarations GENERATED from a glob
// grammar, against an oracle that walks the disk and asks `Bun.Glob` one
// brace-free pattern at a time. `inputs-property.test.ts` draws from a fixed
// menu with hand predicates and owns git visibility (ignored, untracked,
// links, refusals); here every file is visible, and what is under test is
// the matcher the resolver compiles (RegExp fast path, brace expansion,
// literal-as-tree, negation) plus three laws a menu cannot state: the set
// never leaves the project, the order of the entries does not matter, and a
// second resolution answers the same.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { GitFilesCache, populateGitFilesCache, resolveInputs } from '../src/cache/inputs.js'

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

const DIRS = ['src', 'lib', '.cfg', 'sub', 'a b']
const FILES = ['a.ts', 'ab.ts', 'b.md', '.env', 'c.json', 'x.ts']
// Literal atoms name real entries and near misses (`a`, `src2`), so a
// literal is sometimes a file, sometimes a tree, sometimes nothing. A brace
// alternative holding a slash or a globstar is what `Bun.Glob` alone
// misreads, so the resolver expands braces first.
const DIR_ATOMS = [
  ...DIRS,
  '*',
  '**',
  '?ib',
  's*',
  'src2',
  '{src,lib}',
  '{.cfg,a b}',
  '{src,lib/*}',
]
const LEAF_ATOMS = [
  ...FILES,
  'a',
  '*',
  '**',
  '*.ts',
  '?.ts',
  '.*',
  'a*',
  '*.{ts,md}',
  '{a,b}.*',
  '{*.md,**/a.ts}',
  '{**,x.ts}',
]
// Reaches out of the project: the boundary must hold whatever these match.
const ESCAPES = ['../pkg-b/**', '../*/a.ts', '../**']

interface Fixture {
  root: string
  pkg: string
  nested: string | undefined
  /** Every project-relative file under `pkg`, nested project's included. */
  files: string[]
}

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.name === '.git') continue
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r))
    else out.push(r)
  }
  return out
}

async function build(rand: () => number): Promise<Fixture> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-ifuzz-'))
  roots.push(root)
  git(root, 'init', '-q')
  const pkg = path.join(root, 'pkg')
  // One level down too: a nested project's files are refused at any depth.
  const nested = rand() < 0.5 ? path.join(pkg, pick(['sub', 'lib/sub'])) : undefined
  const write = (abs: string): void => {
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, abs)
  }
  write(path.join(pkg, 'package.json'))
  if (nested !== undefined) write(path.join(nested, 'package.json'))
  // The sibling and the root hold the same names the project does, so a
  // path that crossed the boundary would match the same globs.
  const sibling = path.join(root, 'pkg-b')
  write(path.join(sibling, 'package.json'))
  for (const f of FILES) {
    write(path.join(sibling, f))
    write(path.join(root, f))
  }
  const dirsTaken = new Set<string>()
  const filesTaken = new Set<string>(['package.json'])
  const n = 16 + Math.floor(rand() * 20)
  for (let i = 0; i < n; i++) {
    const dirs = Array.from({ length: Math.floor(rand() * 3) }, () => pick(DIRS))
    const rel = [...dirs, pick(FILES)].join('/')
    const prefixes = dirs.map((_, k) => dirs.slice(0, k + 1).join('/'))
    if (prefixes.some((p) => filesTaken.has(p)) || dirsTaken.has(rel)) continue
    for (const p of prefixes) dirsTaken.add(p)
    filesTaken.add(rel)
    write(path.join(pkg, rel))
  }
  // Half tracked, half untracked: both are visible, through two lists.
  const all = walk(root)
  const tracked = all.filter(() => rand() < 0.5)
  if (tracked.length > 0) git(root, '--literal-pathspecs', 'add', '--', ...tracked)
  return { root, pkg, nested, files: walk(pkg) }
}

function genGlob(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  if (rand() < 0.06) return pick(ESCAPES)
  const segs = Array.from({ length: Math.floor(rand() ** 2 * 3) }, () => pick(DIR_ATOMS))
  segs.push(pick(LEAF_ATOMS))
  // `**/**` is one globstar in Bun.Glob's reading too, but it is not a
  // shape the grammar needs to make interesting.
  const g = segs.filter((s, i) => !(s === '**' && segs[i - 1] === '**')).join('/')
  const r = rand()
  return r < 0.1 ? `./${g}` : r < 0.15 && !/[*?{]/.test(g) ? `${g}/` : g
}

/** `a{b,c}d` → `abd`, `acd`; the grammar never nests a brace. */
function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g)
  if (m === null) return [g]
  return m[1]!
    .split(',')
    .flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)))
}

/** Whether `rel` is matched by one entry, by the documented rules alone. */
function entryMatches(entry: string, rel: string): boolean {
  const g = entry.replace(/^\.\//, '')
  if (!/[*?{}]/.test(g)) {
    const lit = g.replace(/\/+$/, '')
    return rel === lit || rel.startsWith(`${lit}/`)
  }
  return expandBraces(g).some((alt) => new Bun.Glob(alt).match(rel))
}

function oracle(fx: Fixture, files: readonly string[]): string[] {
  const pos = files.filter((f) => !f.startsWith('!'))
  const neg = files.filter((f) => f.startsWith('!')).map((f) => f.slice(1))
  return fx.files
    .filter(
      (rel) => fx.nested === undefined || !rel.startsWith(`${path.relative(fx.pkg, fx.nested)}/`),
    )
    .filter(
      (rel) => pos.some((g) => entryMatches(g, rel)) && !neg.some((g) => entryMatches(g, rel)),
    )
    .map((rel) => path.join(fx.pkg, rel))
    .sort()
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

async function resolve(fx: Fixture, files: string[], populate: boolean): Promise<string[]> {
  let gitFilesCache: GitFilesCache | undefined
  if (populate) {
    gitFilesCache = new GitFilesCache()
    const dirs = [fx.pkg, path.join(fx.root, 'pkg-b'), ...(fx.nested ? [fx.nested] : [])]
    await populateGitFilesCache(fx.root, dirs, gitFilesCache)
  }
  const r = await resolveInputs({
    projectDir: fx.pkg,
    workspaceRoot: fx.root,
    envSource: {},
    inputs: { files },
    ownOutputs: [],
    nestedProjectDirs: fx.nested === undefined ? [] : [fx.nested],
    ...(gitFilesCache !== undefined ? { gitFilesCache } : {}),
  })
  return r.files
}

for (let seed = 1; seed <= 12; seed++) {
  it(`seed ${seed}: generated globs resolve to the oracle's set, in any order, every time`, async () => {
    const rand = mulberry32(seed * 7919)
    const fx = await build(rand)
    for (let k = 0; k < 5; k++) {
      const files = [
        ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => genGlob(rand)),
        ...Array.from({ length: Math.floor(rand() * 3) }, () => `!${genGlob(rand)}`),
      ]
      const want = oracle(fx, files)
      const got = await resolve(fx, files, true)
      expect({ files, got }).toEqual({ files, got: want })
      expect(got.filter((f) => !f.startsWith(`${fx.pkg}/`))).toEqual([])
      const reordered = shuffled(files, rand)
      expect({ reordered, got: await resolve(fx, reordered, true) }).toEqual({ reordered, got })
      expect({ files, again: await resolve(fx, files, k % 2 === 1) }).toEqual({ files, again: got })
    }
  })
}
