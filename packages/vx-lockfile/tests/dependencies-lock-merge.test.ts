// `.vx/dependencies.lock` across real two-branch git merges, as bun()
// writes it: each branch changes bun.lock and `vx lock`s, and the merge of
// the dependency lock is clean and what `vx lock --check` derives, or a run
// refuses with "run `vx lock`" and `vx lock` settles it. bun.lock is the
// user's to settle (`bun install`); the test writes the merged one.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const CORE_BIN = path.resolve(import.meta.dir, '../node_modules/.bin/vx')
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const LOCK = '.vx/dependencies.lock'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Each project, its external dependencies by name and version. */
type State = Record<string, Record<string, string>>

const bunLock = (s: State): string => {
  const names = Object.keys(s).sort()
  const workspaces: Record<string, unknown> = { '': { name: 'ws' } }
  const packages: Record<string, unknown> = {}
  for (const n of names) {
    const deps = Object.fromEntries(Object.keys(s[n]!).map((d) => [d, '^1.0.0']))
    workspaces[`packages/${n}`] = { name: n, dependencies: deps }
    packages[n] = [`${n}@workspace:packages/${n}`]
  }
  for (const n of names)
    for (const [d, v] of Object.entries(s[n]!))
      packages[d] = [`${d}@${v}`, '', {}, `sha512-${d}${v}`]
  return `${JSON.stringify({ lockfileVersion: 1, workspaces, packages }, null, 2)}\n`
}

async function write(r: string, s: State): Promise<void> {
  await rm(path.join(r, 'packages'), { recursive: true, force: true })
  for (const [n, deps] of Object.entries(s)) {
    const dir = path.join(r, 'packages', n)
    await mkdir(dir, { recursive: true })
    const dependencies = Object.fromEntries(Object.keys(deps).map((d) => [d, '^1.0.0']))
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: n, dependencies }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'echo ${n}' } } } }\n`,
    )
  }
  await writeFile(path.join(r, 'bun.lock'), bunLock(s))
}

const vx = (r: string, ...args: string[]) => {
  // Plain text whatever runs the suite: under vx, FORCE_COLOR splits the line.
  const { FORCE_COLOR: _, ...env } = process.env
  const p = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, ...args],
    cwd: r,
    stderr: 'pipe',
    env: { ...env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, err: p.stderr.toString() }
}

function git(r: string, ...args: string[]): string {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@vx',
      '-c',
      'user.name=t',
      ...args,
    ],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.stdout.toString()
}

/** Base, theirs and ours each written and locked; the merge, bun.lock settled to `settled`. */
async function merged(
  base: State,
  ours: State,
  theirs: State,
  settled: State,
): Promise<'clean' | 'relocked'> {
  const r = (root = await mkdtemp(path.join(tmpdir(), 'vx-lockfile-merge-')))
  await writeFile(
    path.join(r, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(
    path.join(r, '.vx/workspace.mjs'),
    localWorkspaceSource(['bun()'], `import { bun } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  git(r, 'init', '-q')
  const step = async (s: State, msg: string) => {
    await write(r, s)
    expect(vx(r, 'lock')).toEqual({ code: 0, err: expect.any(String) })
    git(r, 'add', '-A')
    git(r, 'commit', '-qm', msg)
  }
  await step(base, 'base')
  git(r, 'checkout', '-qb', 'theirs')
  await step(theirs, 'theirs')
  git(r, 'checkout', '-q', '-')
  await step(ours, 'ours')
  git(r, 'merge', '-q', '--no-edit', 'theirs')
  await writeFile(path.join(r, 'bun.lock'), bunLock(settled))
  git(r, 'add', 'bun.lock')
  const unmerged = git(r, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
  // Only the dependency lock may clash: each case keeps every other file apart.
  expect(unmerged.filter((f) => f !== LOCK)).toEqual([])
  const check = vx(r, 'lock', '--check')
  if (unmerged.length === 0 && check.code === 0) return 'clean'
  expect(check.err).toContain('run `vx lock`')
  const run = vx(r, 'run', '--all', 'build')
  expect(run.code).not.toBe(0)
  expect(run.err).toContain('vx lock')
  expect(vx(r, 'lock').code).toBe(0)
  expect(vx(r, 'lock', '--check').code).toBe(0)
  return 'relocked'
}

// In name-hash order: d, b, c, a.
const h = (n: string) => Bun.hash.xxHash3(n)
const base: State = {
  a: { 'dep-a': '1.0.0' },
  b: { 'dep-b': '1.0.0' },
  c: { 'dep-c': '1.0.0' },
  d: { 'dep-d': '1.0.0' },
}
const bump = (s: State, n: string, v = '1.1.0'): State => ({
  ...s,
  [n]: Object.fromEntries(Object.keys(s[n]!).map((d) => [d, v])),
})
// A project whose name hashes between b and c.
const between = Array.from({ length: 500 }, (_, i) => `p${i}`).find(
  (n) => h(n) > h('b') && h(n) < h('c'),
)!

it('merges two branches that bump the dependencies of neighbouring projects', async () => {
  const outcome = await merged(base, bump(base, 'b'), bump(base, 'c'), bump(bump(base, 'b'), 'c'))
  expect(outcome).toBe('clean')
})

it('merges a dependency added to one project with a bump of its neighbour', async () => {
  const added = { ...base, b: { 'dep-b': '1.0.0', 'dep-x': '1.0.0' } }
  const outcome = await merged(base, added, bump(base, 'c'), bump(added, 'c'))
  expect(outcome).toBe('clean')
})

for (const edited of ['b', 'c'])
  it(`merges a new project with a bump of its neighbour ${edited}`, async () => {
    const grown = { ...base, [between]: { [`dep-${between}`]: '1.0.0' } }
    const outcome = await merged(base, bump(base, edited), grown, bump(grown, edited))
    expect(outcome).toBe('clean')
  })

for (const edited of ['b', 'a'])
  it(`merges a removed project with a bump of its neighbour ${edited}`, async () => {
    const { c: _, ...shrunk } = base
    const outcome = await merged(base, shrunk, bump(base, edited), bump(shrunk, edited))
    expect(outcome).toBe('clean')
  })

it('refuses two re-resolves of one project until vx lock', async () => {
  const outcome = await merged(
    base,
    bump(base, 'b'),
    bump(base, 'b', '1.2.0'),
    bump(base, 'b', '1.2.0'),
  )
  expect(outcome).toBe('relocked')
})
