// A run that loads only a few projects lets git scan just their dirs
// (`gitPathspecs`: scoped pathspecs under 64 dirs); a run that loads more,
// or declares `workspaceFiles`, scans the whole tree and partitions it.
// Both feed the same cache key, so the two enumerations must agree on
// every project partition — files AND trusted OIDs — for every worktree
// state git can present. A divergence would key the same task two ways
// depending on which OTHER projects a run happened to load: a stale-hit
// class of defect. Property-tested over seeded random trees rather than a
// hand-picked layout: the states that matter (a modified, a deleted, a
// staged, an untracked, an ignored file; an untracked directory; a project
// whose dir is a prefix of another's; a nested project; a name with a
// space and a non-ASCII name) are all drawn every seed, in random mixes.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitInit, gitIn, makeWorkspace } from './helpers/workspace.js'
import { GitFilesCache, populateGitFilesCache } from '../src/cache/inputs.js'

// mulberry32: a seed reproduces a tree exactly, so a failing seed is a
// fixture, not a flake.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type State = 'clean' | 'modified' | 'deleted' | 'staged' | 'untracked' | 'ignored' | 'untracked-dir'
const STATES: readonly State[] = [
  'clean',
  'modified',
  'deleted',
  'staged',
  'untracked',
  'ignored',
  'untracked-dir',
]
const NAMES = ['index.ts', 'a b.ts', 'ünï.md', 'deep/inner/x.js', 'README', '.dotfile']

interface Plan {
  projects: string[]
  files: Array<{ project: string; rel: string; state: State }>
}

function plan(seed: number): Plan {
  const next = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
  // `a` is a prefix of `ab` (the `dir/` range must not bleed); `a/nested`
  // sits inside `a` (both see its files under their own names).
  const projects = ['packages/a', 'packages/ab', 'packages/a/nested', 'tools/c', 'packages/d']
  const files: Plan['files'] = []
  for (const project of projects) {
    // Every state at least once per seed across the tree, then a random tail.
    const count = 3 + Math.floor(next() * 4)
    for (let i = 0; i < count; i++) {
      const state =
        i === 0 ? STATES[(seed + projects.indexOf(project)) % STATES.length]! : pick(STATES)
      const base = pick(NAMES)
      const rel = state === 'untracked-dir' ? `fresh-${i}/${base}` : `${i}-${base}`
      files.push({ project, rel, state })
    }
  }
  return { projects, files }
}

async function materialize(root: string, p: Plan): Promise<void> {
  const git = gitIn(root)
  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
  await write('.gitignore', '*.ignored\n')
  // Committed layer: everything that starts tracked.
  for (const f of p.files) {
    const rel = `${f.project}/${f.rel}`
    if (f.state === 'clean' || f.state === 'modified' || f.state === 'deleted')
      await write(rel, `v1 ${rel}`)
  }
  for (const project of p.projects) await write(`${project}/package.json`, `{"name":"${project}"}`)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // Worktree layer.
  for (const f of p.files) {
    const rel = `${f.project}/${f.rel}`
    switch (f.state) {
      case 'modified':
        await write(rel, `v2 ${rel}`)
        break
      case 'deleted':
        await rm(path.join(root, rel))
        break
      case 'staged':
        await write(rel, `staged ${rel}`)
        git('add', '--', rel)
        break
      case 'untracked':
      case 'untracked-dir':
        await write(rel, `new ${rel}`)
        break
      case 'ignored':
        await write(`${rel}.ignored`, 'ignored')
        break
      case 'clean':
        break
    }
  }
}

function partition(
  cache: GitFilesCache,
  dir: string,
): { files: string[]; oids: Array<[string, string]> } {
  return {
    files: [...(cache.get(dir) ?? [])].sort(),
    oids: [...(cache.oidsFor(dir) ?? new Map<string, string>())].sort(([a], [b]) =>
      a < b ? -1 : 1,
    ),
  }
}

describe('scoped and whole-repo git enumeration agree on every project partition', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-enum-', git: false, workspaceFile: false })
    gitInit(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    it(`seed ${seed}`, async () => {
      const p = plan(seed)
      await materialize(root, p)
      const dirs = p.projects.map((rel) => path.join(root, rel))

      const scoped = new GitFilesCache()
      await populateGitFilesCache(root, dirs, scoped, false)
      const whole = new GitFilesCache()
      await populateGitFilesCache(root, dirs, whole, true)

      for (const project of p.projects) {
        const dir = path.join(root, project)
        const a = partition(scoped, dir)
        const b = partition(whole, dir)
        expect(a).toEqual(b)
        // And both equal what the plan says the partition holds: every
        // non-ignored file of the project and of any project nested in it
        // (a deleted tracked file stays — the index knows it; an ignored
        // one never appears; an untracked one does), nothing from a
        // sibling whose dir shares a prefix.
        const under = (q: string): string =>
          q === project ? '' : `${q.slice(project.length + 1)}/`
        const expected = p.projects
          .filter((q) => q === project || q.startsWith(`${project}/`))
          .flatMap((q) => [
            `${under(q)}package.json`,
            ...p.files
              .filter((f) => f.project === q && f.state !== 'ignored')
              .map((f) => `${under(q)}${f.rel}`),
          ])
          .sort()
        expect(a.files).toEqual(expected)
        // Trusted OIDs are exactly the clean tracked files: a modified,
        // deleted or staged path never keeps its committed OID.
        const trusted = a.oids
          .map(([abs]) => path.relative(dir, abs).split(path.sep).join('/'))
          .sort()
        const cleanExpected = p.projects
          .filter((q) => q === project || q.startsWith(`${project}/`))
          .flatMap((q) => [
            `${under(q)}package.json`,
            ...p.files
              .filter((f) => f.project === q && f.state === 'clean')
              .map((f) => `${under(q)}${f.rel}`),
          ])
          .sort()
        expect(trusted).toEqual(cleanExpected)
      }
      expect(scoped.worktreeDirty).toBe(whole.worktreeDirty)
    })
  }
})
