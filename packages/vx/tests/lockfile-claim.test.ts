// The claimant's shell (`lockfileClaim`): the memo, the per-run gate, the
// fallback for an unlisted project and the `--affected` diff, with a fake
// digest so the pins are about the shell and not a lockfile format. The
// real formats are pinned in @vzn/vx-lockfile, one file per manager.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lockfileClaim, reachDigests } from '../src/index.js'
import type { TaskNode } from '../src/graph/index.js'

let root: string
let calls: string[]

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-claim-'))
  await mkdir(path.join(root, '.vx', 'cache'), { recursive: true })
  calls = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A "lockfile" whose lines are `dir=digest`; the digest records every parse. */
function claim(scope?: 'project' | 'workspace') {
  return lockfileClaim({
    file: 'bun.lock',
    version: 1,
    ...(scope === undefined ? {} : { scope }),
    digest: (text) => {
      calls.push(text)
      const out = new Map<string, string>()
      for (const line of text.split('\n')) {
        const [dir, digest] = line.split('=')
        if (dir && digest) out.set(dir, digest)
      }
      return out
    },
  })
}
const ctx = () => ({ workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} })
const task = (dir: string) => ({ projectDir: path.join(root, dir) }) as TaskNode
const lock = (text: string) => writeFile(path.join(root, 'bun.lock'), text)
const MEMO = () => path.join(root, '.vx', 'cache', 'lockfile-claims', 'bun.lock.json')

describe('key', () => {
  it("folds the project's digest, the root's for an unlisted project, and nothing without a file", async () => {
    const hooks = claim()
    expect(await hooks.key(task('packages/a'), ctx())).toBeUndefined()
    await lock('.=root1\npackages/a=a1\n')
    expect(await hooks.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    expect(await hooks.key(task('packages/b'), ctx())).toEqual({ deps: 'root1' })
    expect(await hooks.key(task('.'), ctx())).toEqual({ deps: 'root1' })
  })

  it('parses once per content: the memo serves the next process, the context the next task', async () => {
    await lock('.=root1\npackages/a=a1\n')
    const first = claim()
    const run = ctx()
    await first.key(task('packages/a'), run)
    await first.key(task('packages/b'), run)
    expect(calls).toHaveLength(1)
    // The memo is on disk, keyed by version + content hash.
    const memo = JSON.parse(await readFile(MEMO(), 'utf8')) as {
      version: number
      importers: Record<string, string>
    }
    expect(memo.version).toBe(1)
    expect(memo.importers).toEqual({ '.': 'root1', 'packages/a': 'a1' })
    // A fresh instance (a new process) reads the memo instead of parsing.
    const second = claim()
    expect(await second.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    expect(calls).toHaveLength(1)
    // A planted memo is what keys the task: the proof the file was not parsed.
    memo.importers['packages/a'] = 'planted'
    await writeFile(MEMO(), JSON.stringify(memo))
    expect(await claim().key(task('packages/a'), ctx())).toEqual({ deps: 'planted' })
    expect(calls).toHaveLength(1)
    // Changed bytes ignore the stale memo and parse again.
    await lock('.=root1\npackages/a=a2\n')
    expect(await claim().key(task('packages/a'), ctx())).toEqual({ deps: 'a2' })
    expect(calls).toHaveLength(2)
  })

  it('a memo of another digest version is not trusted', async () => {
    await lock('.=root1\n')
    await claim().key(task('.'), ctx())
    const hooks = lockfileClaim({
      file: 'bun.lock',
      version: 2,
      digest: () => new Map([['.', 'v2']]),
    })
    expect(await hooks.key(task('.'), ctx())).toEqual({ deps: 'v2' })
  })

  it('scope: workspace folds the file hash into every task and never parses', async () => {
    await lock('.=root1\npackages/a=a1\n')
    const hooks = claim('workspace')
    const a = await hooks.key(task('packages/a'), ctx())
    const b = await hooks.key(task('packages/b'), ctx())
    expect(a).toEqual(b)
    expect(a).toHaveProperty('deps')
    expect(calls).toHaveLength(0)
    await lock('.=root1\npackages/a=a2\n')
    expect(await hooks.key(task('packages/b'), ctx())).not.toEqual(b)
  })

  it('names the part as asked', async () => {
    await lock('.=root1\n')
    const hooks = lockfileClaim({
      file: 'bun.lock',
      version: 1,
      part: 'bun',
      digest: () => new Map([['.', 'r']]),
    })
    expect(await hooks.key(task('.'), ctx())).toEqual({ bun: 'r' })
  })

  it('refuses an unknown scope', () => {
    expect(() =>
      lockfileClaim({ file: 'bun.lock', version: 1, digest: () => new Map(), scope: 'x' as never }),
    ).toThrow(/scope must be 'project' or 'workspace'/)
  })
})

describe('affected', () => {
  const projects = () => [
    { name: 'a', dir: path.join(root, 'packages/a') },
    { name: 'b', dir: path.join(root, 'packages/b') },
    { name: 'tools', dir: path.join(root, 'tools') },
  ]
  const bytes = (s: string) => new TextEncoder().encode(s)
  const ask = (hooks: ReturnType<typeof claim>, before: string | null, after: string | null) =>
    hooks.fingerprint.affected(
      {
        file: 'bun.lock',
        before: before === null ? null : bytes(before),
        after: after === null ? null : bytes(after),
      },
      { ...ctx(), projects: projects() },
    )

  it('names the projects whose digest moved; an unlisted project follows the root', async () => {
    const base = '.=r1\npackages/a=a1\npackages/b=b1\n'
    expect([...(await ask(claim(), base, '.=r1\npackages/a=a2\npackages/b=b1\n'))!]).toEqual(['a'])
    expect([...(await ask(claim(), base, '.=r2\npackages/a=a1\npackages/b=b1\n'))!]).toEqual([
      'tools',
    ])
    expect([...(await ask(claim(), base, base))!]).toEqual([])
  })

  it('cannot tell when the file appeared or went, or under scope: workspace', async () => {
    expect(await ask(claim(), null, '.=r1\n')).toBeUndefined()
    expect(await ask(claim(), '.=r1\n', null)).toBeUndefined()
    expect(await ask(claim('workspace'), '.=r1\n', '.=r2\n')).toBeUndefined()
  })
})

describe('reachDigests', () => {
  // 0 → 1 → 2, 2 → 1 (a cycle), 3 alone.
  const graph = (m: string[]) => ({ material: m, edges: [[1], [2], [1], []] })

  it('moves a node when anything it reaches changes, and only then', () => {
    const before = reachDigests(graph(['a', 'b', 'c', 'd']))
    const deep = reachDigests(graph(['a', 'b', 'c2', 'd']))
    expect(deep[0]).not.toBe(before[0])
    expect(deep[1]).not.toBe(before[1])
    expect(deep[2]).not.toBe(before[2])
    expect(deep[3]).toBe(before[3])
    const leaf = reachDigests(graph(['a', 'b', 'c', 'd2']))
    expect(leaf.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(leaf[3]).not.toBe(before[3])
  })

  it('is independent of node numbering and edge order', () => {
    const a = reachDigests({ material: ['x', 'y', 'z'], edges: [[1, 2], [], []] })
    const b = reachDigests({ material: ['z', 'x', 'y'], edges: [[], [2, 0], []] })
    expect(b[1]).toBe(a[0])
    expect(b[2]).toBe(a[1])
    expect(b[0]).toBe(a[2])
  })

  it('a member of a cycle shares its component digest', () => {
    const d = reachDigests(graph(['a', 'b', 'c', 'd']))
    expect(d[1]).toBe(d[2])
    expect(d[0]).not.toBe(d[1])
  })
})
