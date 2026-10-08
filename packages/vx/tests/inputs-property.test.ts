// Seeded random trees against an oracle that shares nothing with the
// resolver: each glob in the menu carries a hand-written predicate, and the
// tree's visibility, boundary and file-kind facts come from how the fixture
// built it, not from git or Bun.Glob. Both routes into `resolveFiles` are
// driven, the run's populated partition and the per-project git spawn.

import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it, setDefaultTimeout } from 'bun:test'
import { GitFilesCache, populateGitFilesCache, resolveInputs } from '../src/cache/inputs.js'
import { relPosix } from '../src/util/index.js'
import { rng } from './helpers/rng.js'

setDefaultTimeout(60_000)

// U+FFFF leads a name on purpose: the partition's upper bound once was
// `dir/` + U+FFFF, and such a file fell out of every project's inputs.
// APFS refuses the name (EILSEQ), so no such file exists there to lose;
// U+FFFD keeps the tree's shape on a file system that says so.
const HI = ((): string => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'vx-iprop-'))
  try {
    mkdirSync(path.join(probe, '\uffff'))
    return '\uffff'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EILSEQ') throw e
    return '\ufffd'
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()
const DIRS = ['src', 'lib', '[id]', '.hidden', 'node_modules', 'ign', `${HI}d`]
const FILES = ['a.ts', '.env', 'b.md', '*.ts', 'x.log', '[id].ts', `${HI}.ts`, 'c d.ts']

const segs = (r: string): string[] => r.split('/')
const base = (r: string): string => segs(r).at(-1)!
const tree = (dir: string) => (r: string) => r === dir || r.startsWith(`${dir}/`)

// The third field is the path a literal entry names: one on disk with
// nothing under it git reports is refused, never folded as nothing.
const POSITIVE: Array<[string, (r: string) => boolean, string?]> = [
  ['**/*', () => true],
  ['./**/*.ts', (r) => r.endsWith('.ts')],
  ['src', tree('src'), 'src'],
  ['src/', tree('src'), 'src'],
  ['[id]/**', (r) => r.startsWith('[id]/')],
  ['**/.*', (r) => base(r).startsWith('.')],
  ['*.md', (r) => !r.includes('/') && r.endsWith('.md')],
  ['{src,lib}/**', (r) => r.startsWith('src/') || r.startsWith('lib/')],
  ['**/[id]/*', (r) => segs(r).at(-2) === '[id]'],
  [`${HI}d`, tree(`${HI}d`), `${HI}d`],
]
const NEGATIVE: Array<[string, (r: string) => boolean]> = [
  ['!**/*.md', (r) => r.endsWith('.md')],
  ['!lib', tree('lib')],
  ['!./src/.*', (r) => segs(r).length === 2 && r.startsWith('src/.')],
  [`!**/${HI}*`, (r) => base(r).startsWith(HI)],
]

interface Fixture {
  root: string
  pkg: string
  nested: string | undefined
  /**
   * Project-relative path → whether the enumeration lists it: tracked, or
   * untracked and neither ignored nor under a `node_modules` (an install).
   */
  entries: Map<string, boolean>
}

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

async function build(rand: () => number): Promise<Fixture> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-iprop-'))
  roots.push(root)
  git(root, 'init', '-q')
  writeFileSync(path.join(root, '.gitignore'), 'ign/\n*.log\n')
  const pkg = path.join(root, 'pkg')
  // Siblings whose names sort right next to `pkg/`: never this project's. A
  // sibling file under a name the project also has is how a leak shows, as
  // the probe that drops a phantom path finds the project's own file there.
  for (const sib of ['pkg-b', 'pkg.c', 'pkg0', `pkg${HI}`]) {
    mkdirSync(path.join(root, sib))
    writeFileSync(path.join(root, sib, 'package.json'), sib)
  }
  const nested = rand() < 0.5 ? path.join(pkg, 'sub') : undefined
  const entries = new Map<string, boolean>()
  const tracked: string[] = []
  const add = (rel: string, link: string | undefined): void => {
    const abs = path.join(pkg, rel)
    if (lstatSync(abs, { throwIfNoEntry: false }) !== undefined) return
    mkdirSync(path.dirname(abs), { recursive: true })
    if (link === undefined) writeFileSync(abs, rel)
    else symlinkSync(link, abs)
    const ignored = segs(rel).includes('ign') || rel.endsWith('.log')
    const installed = segs(rel).includes('node_modules')
    const track = rand() < 0.5
    if (track) tracked.push(rel)
    entries.set(rel, track || (!ignored && !installed))
  }
  add('package.json', undefined)
  const n = 6 + Math.floor(rand() * 14)
  for (let i = 0; i < n; i++) {
    const depth = Math.floor(rand() * 3)
    const dirs = Array.from({ length: depth }, () => pick(DIRS))
    if (rand() < 0.2) dirs.unshift('sub')
    // A directory name must not already be a file at that path.
    const rel = [...dirs, pick(FILES)].join('/')
    const clash = dirs.some((_, k) => entries.has(dirs.slice(0, k + 1).join('/')))
    if (clash) continue
    add(rel, rand() < 0.15 ? 'a.ts' : undefined)
  }
  if (rand() < 0.3) add('linkdir', 'src')
  if (nested !== undefined) {
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'package.json'), '{}')
    entries.set('sub/package.json', true)
  }
  // Files under `ign/` are tracked by force; their siblings stay ignored.
  // Literal: `*.ts` is a pathspec glob, and CI's git 2.55 force-added every
  // ignored `.ts` it matched (2.43 took the exact name alone).
  for (const rel of tracked) git(pkg, '--literal-pathspecs', 'add', '-f', '--', rel)
  return { root, pkg, nested, entries }
}

function oracle(
  fx: Fixture,
  pos: Array<(r: string) => boolean>,
  neg: Array<(r: string) => boolean>,
): string[] {
  const out: string[] = []
  for (const [rel, visible] of fx.entries) {
    if (!visible) continue
    if (fx.nested !== undefined && rel.startsWith('sub/')) continue
    if (!pos.some((p) => p(rel)) || neg.some((p) => p(rel))) continue
    out.push(rel)
  }
  return out.sort()
}

for (let seed = 1; seed <= 24; seed++) {
  it(`seed ${seed}: the resolved inputs are exactly the oracle's`, async () => {
    const rand = rng(seed)
    const fx = await build(rand)
    const projectDirs = fx.nested === undefined ? [fx.pkg] : [fx.pkg, fx.nested]
    for (let k = 0; k < 6; k++) {
      const pos = POSITIVE.filter(() => rand() < 0.3)
      if (pos.length === 0) pos.push(POSITIVE[Math.floor(rand() * POSITIVE.length)]!)
      const neg = NEGATIVE.filter(() => rand() < 0.3)
      const files = [...pos, ...neg].map(([g]) => g)
      const want = oracle(
        fx,
        pos.map(([, p]) => p),
        neg.map(([, p]) => p),
      )
      const all = [...fx.entries]
      const refused = pos.some(
        ([, , lit]) =>
          lit !== undefined &&
          all.some(([r]) => tree(lit)(r)) &&
          !all.some(([r, visible]) => visible && tree(lit)(r)),
      )
      const populated = new GitFilesCache()
      await populateGitFilesCache(fx.root, projectDirs, populated)
      for (const gitFilesCache of [populated, undefined]) {
        const resolving = resolveInputs({
          projectDir: fx.pkg,
          workspaceRoot: fx.root,
          envSource: {},
          inputs: { files },
          ownOutputs: [],
          nestedProjectDirs: fx.nested === undefined ? [] : [fx.nested],
          ...(gitFilesCache !== undefined ? { gitFilesCache } : {}),
        })
        const route = `${JSON.stringify(files)} ${gitFilesCache ? 'populated' : 'spawned'}`
        const got = await resolving.then(
          (r) => r.files.map((f) => relPosix(fx.pkg, f)),
          (e: Error) =>
            /^cache\.inputs\.files: ".*" exists in .* but git does not report it/.test(e.message)
              ? 'refused'
              : e.message,
        )
        expect({ route, got }).toEqual({ route, got: refused ? 'refused' : want })
      }
    }
  })
}
