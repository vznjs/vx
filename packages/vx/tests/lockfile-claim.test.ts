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
    await lock('packages/a=a1\n')
    expect(await hooks.key(task('packages/a'), ctx())).toEqual({ deps: 'a1' })
    await lock('.=root1\npackages/a=a1\n')
    expect(await hooks.key(task('packages/b'), ctx())).toEqual({ deps: 'root1' })
    expect(await hooks.key(task('.'), ctx())).toEqual({ deps: 'root1' })
  })

  it("a listed project folds the root importer's digest too: the root's tools are on its PATH", async () => {
    // The root `node_modules/.bin` is on every task's PATH and Node's
    // resolution walks up to the root `node_modules`, so a root
    // devDependency bump that moved no project's key replayed the old
    // tool's output (nx#36415 class, 2026-09-24).
    const hooks = claim()
    const key = async (text: string, dir: string) => {
      await lock(text)
      return (await hooks.key(task(dir), ctx()))!['deps']!
    }
    const base = await key('.=root1\npackages/a=a1\npackages/b=b1\n', 'packages/a')
    const rootMoved = await key('.=root2\npackages/a=a1\npackages/b=b1\n', 'packages/a')
    const ownMoved = await key('.=root1\npackages/a=a2\npackages/b=b1\n', 'packages/a')
    const sibling = await key('.=root1\npackages/a=a1\npackages/b=b2\n', 'packages/a')
    expect(new Set([base, rootMoved, ownMoved]).size).toBe(3)
    // CONTROL: a sibling's own closure is not a's.
    expect(sibling).toBe(base)
    // Neither half alone: a's key is not the root's, nor its own bare digest.
    expect(base).not.toBe('root1')
    expect(base).not.toBe('a1')
  })

  it('parses once per content: the memo serves the next process, the context the next task', async () => {
    // No root importer: these rows are about the memo, so a's key is its own digest.
    await lock('packages/a=a1\n')
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
    expect(memo.importers).toEqual({ 'packages/a': 'a1' })
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
    await lock('packages/a=a2\n')
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

  it('a memo it CANNOT write is a speed-up lost, never a failed run', async () => {
    // The memo is written under the cache dir; if that write fails — a
    // read-only cache, a full disk, a path that is not a directory — the
    // digests were computed anyway and the run must carry on. The next run
    // simply computes them again.
    await lock('packages/a=a1\n')
    const blocked = path.join(root, 'not-a-dir')
    await writeFile(blocked, 'this is a file, so lockfile-claims/ cannot be made under it')
    const hooks = claim()
    const blockedCtx = { workspaceRoot: root, cacheDir: blocked, warn() {} }
    expect(await hooks.key(task('packages/a'), blockedCtx)).toEqual({ deps: 'a1' })
    // A second run over the same content re-parses, since nothing was
    // memoised — the cost the memo exists to avoid, paid rather than fatal.
    expect(await claim().key(task('packages/a'), { ...blockedCtx })).toEqual({ deps: 'a1' })
    expect(calls.length).toBe(2)
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

  it('names the projects whose digest moved; a root move moves every project', async () => {
    const base = '.=r1\npackages/a=a1\npackages/b=b1\n'
    expect([...(await ask(claim(), base, '.=r1\npackages/a=a2\npackages/b=b1\n'))!]).toEqual(['a'])
    expect([...(await ask(claim(), base, '.=r2\npackages/a=a1\npackages/b=b1\n'))!]).toEqual([
      'a',
      'b',
      'tools',
    ])
    expect([...(await ask(claim(), base, base))!]).toEqual([])
  })

  it('a side that cannot be parsed is refused, and the refusal names WHICH side', async () => {
    // "your lockfile is broken" and "the base commit's is" are different
    // problems with different fixes — a lockfile-migration commit hits the
    // second — and the parser's own message names neither (2026-09-20).
    const strict = lockfileClaim({
      file: 'bun.lock',
      version: 1,
      digest: (text) => {
        if (text.includes('broken')) throw new Error('bun.lock: not a lockfile')
        return new Map([['.', text.trim()]])
      },
    })
    // The hook is synchronous for a claim whose digest is, so the refusal
    // arrives as a throw rather than a rejection.
    expect(() => ask(strict, 'broken', '.=r1\n')).toThrow(
      'bun.lock: not a lockfile (as of the base ref)',
    )
    expect(() => ask(strict, '.=r1\n', 'broken')).toThrow(
      'bun.lock: not a lockfile (in the working tree)',
    )
    // CONTROL: two sides that parse still answer with the moved projects.
    expect([...(await ask(strict, '.=r1\n', '.=r2\n'))!]).toEqual(['a', 'b', 'tools'])
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

  it('a SELF-LOOP changes nothing — an edge inside a component is not a child', () => {
    // Children are the components a component points OUT to. An edge that
    // lands back inside it has already been folded as a member, and
    // counting it again would fold a digest that does not exist yet.
    const plain = reachDigests({ material: ['a'], edges: [[]] })
    const loop = reachDigests({ material: ['a'], edges: [[0]] })
    expect(loop[0]).toBe(plain[0])
  })

  it('a cycle LONGER than one edge is still one component', () => {
    // The two-node fixture above closes its cycle with a back edge to the
    // node one frame up, which the on-stack branch alone resolves. A
    // three-node cycle needs the low-link to travel back DOWN the frame
    // stack as each frame pops; without that the ring splits into three
    // components that each claim to reach the others.
    const d = reachDigests({ material: ['a', 'b', 'c'], edges: [[1], [2], [0]] })
    expect(d[0]).toBe(d[1])
    expect(d[1]).toBe(d[2])
    // CONTROL: the same three nodes in a CHAIN are three distinct digests.
    const chain = reachDigests({ material: ['a', 'b', 'c'], edges: [[1], [2], []] })
    expect(new Set(chain).size).toBe(3)
  })

  it('the order a node lists its edges in does not move its digest', () => {
    // The numbering row above permutes the nodes but leaves each node's
    // children arriving in the same order, so it cannot see the sort that
    // makes the fold order-free. Reversing ONE node's edge list can.
    const fwd = reachDigests({ material: ['x', 'y', 'z'], edges: [[1, 2], [], []] })
    const rev = reachDigests({ material: ['x', 'y', 'z'], edges: [[2, 1], [], []] })
    expect(rev[0]).toBe(fwd[0])
  })

  it('the order a COMPONENT pops its members in does not move its digest', () => {
    // Same argument one level down: a multi-member component folds its
    // members sorted, because the pop order off Tarjan's stack is an
    // artefact of where the walk entered the cycle.
    const ab = reachDigests({ material: ['a', 'b'], edges: [[1], [0]] })
    const ba = reachDigests({ material: ['b', 'a'], edges: [[1], [0]] })
    expect(ba[0]).toBe(ab[0])
    expect(ba[1]).toBe(ab[1])
  })

  it('a member and a child digest are in DIFFERENT sections — the counts separate them', () => {
    // The fold is members-then-children, and each section is introduced by
    // its count. Take those two introductions away together and the two
    // sections become one undifferentiated chain, where a node whose CHILD
    // digests to D collides with a component whose MEMBER material is the
    // string D. Child digests are 16 hex chars, which a lockfile's material
    // can be — an integrity hash, a resolved version string.
    const childOnly = reachDigests({ material: ['zz'], edges: [[]] })[0]!
    expect(childOnly).toMatch(/^[0-9a-f]{16}$/)
    const asChild = reachDigests({ material: ['a', 'zz'], edges: [[1], []] })[0]!
    const asMember = reachDigests({ material: ['a', childOnly], edges: [[1], [0]] })[0]!
    expect(asMember).not.toBe(asChild)
  })
})
