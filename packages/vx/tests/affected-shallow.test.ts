// `--affected` in a shallow clone (CI's checkout fetches one commit)
// fetches from origin what the merge base needs and nothing more: the
// base's tip, then history only until git finds the merge base, without
// blobs (2026-10-24: "we only need current commit and branch out
// commit"). Each clone is `file://`, so git honours `--depth`.
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { affectedChanges, defaultAffectedBase } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

let dir: string
let origin: string
let og: (...args: string[]) => string

const changed = async (root: string, since: string) =>
  [...(await affectedChanges({ workspaceRoot: root, since, projects: [] })).changed].sort()
const sha = (root: string, rev: string) => gitIn(root)('rev-parse', rev).trim()
/** The commits the clone holds, a ref reaching them or not (one fetched by id). */
const commits = (root: string) =>
  gitIn(root)('cat-file', '--batch-all-objects', '--batch-check=%(objecttype)')
    .split('\n')
    .filter((t) => t === 'commit').length
const shallow = (root: string) => gitIn(root)('rev-parse', '--is-shallow-repository').trim()

/** A depth-1 clone of `branch`, as actions/checkout makes one: no other ref. */
async function clone(branch: string): Promise<string> {
  const to = await mkdtemp(path.join(dir, 'clone-'))
  gitIn(dir)('clone', '-q', '--depth', '1', '--branch', branch, `file://${origin}`, to)
  return to
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-shallow-'))
  origin = path.join(dir, 'origin')
  await Bun.write(path.join(origin, 'a.txt'), '0\n')
  await Bun.write(path.join(origin, 'b.txt'), 'b0\n')
  await Bun.write(path.join(origin, 'old/x.txt'), '0\n')
  gitInitCommit(origin)
  og = gitIn(origin)
  og('config', 'uploadpack.allowFilter', 'true')
  og('branch', '-M', 'main')
  // History the merge base never needs: a full fetch would take it.
  for (let i = 1; i <= 40; i++) {
    await writeFile(path.join(origin, 'old/x.txt'), `${i}\n`)
    og('commit', '-qam', `old ${i}`)
  }
  og('checkout', '-qb', 'feat')
  await writeFile(path.join(origin, 'b.txt'), '1\n')
  og('commit', '-qam', 'feat one')
  await Bun.write(path.join(origin, 'c.txt'), '1\n')
  og('add', 'c.txt')
  og('commit', '-qm', 'feat two')
  og('checkout', '-q', 'main')
  // The base moved on: its changes are not the branch's.
  for (let i = 1; i <= 5; i++) {
    await writeFile(path.join(origin, 'a.txt'), `${i}\n`)
    og('commit', '-qam', `main ${i}`)
  }
  // A pull request's merge checkout: HEAD's first parent is the base.
  og('checkout', '-qb', 'pr')
  og('merge', '-q', '--no-ff', '-m', 'merge', 'feat')
  og('checkout', '-q', 'main')
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('a shallow clone', () => {
  it("fetches the branch's merge base, not the full history, and diffs from it", async () => {
    const root = await clone('feat')
    expect(await changed(root, 'origin/main')).toEqual(['b.txt', 'c.txt'])
    expect(shallow(root)).toBe('true')
    // CONTROL: the base's own changes are what diffing its tip would add.
    expect((await changed(root, sha(root, 'origin/main'))).length).toBe(2)
    expect(gitIn(root)('diff', '--name-only', 'origin/main').trim().split('\n').sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ])
    expect(commits(root)).toBeLessThan(commits(origin))
  })

  it("a pull request's merge checkout needs its base commit alone", async () => {
    const root = await clone('pr')
    expect(await changed(root, sha(origin, 'main'))).toEqual(['b.txt', 'c.txt'])
    // HEAD and its base: nothing deepened.
    expect(commits(root)).toBe(2)
  })

  it('reaches HEAD~1 by deepening', async () => {
    const root = await clone('feat')
    expect(await changed(root, 'HEAD~1')).toEqual(['c.txt'])
    expect(shallow(root)).toBe('true')
  })

  it('a two-dot range fetches its base as the three-dot one does', async () => {
    // `[A..HEAD]` diffs from A's tip itself, so main's own edit (a.txt) counts.
    expect(await changed(await clone('feat'), 'origin/main..HEAD')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ])
    expect(await changed(await clone('feat'), 'HEAD~1..HEAD')).toEqual(['c.txt'])
  })

  it('fetches a tag base as it fetches a branch', async () => {
    og('tag', '-f', 'light', 'main')
    og('tag', '-f', '-a', '-m', 'annotated', 'ann', 'main')
    expect(await changed(await clone('feat'), 'light')).toEqual(['b.txt', 'c.txt'])
    expect(await changed(await clone('feat'), 'refs/tags/ann')).toEqual(['b.txt', 'c.txt'])
    expect(await changed(await clone('feat'), 'light..HEAD')).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it("a bare --affected with no base branch fetches origin's default", async () => {
    const root = await clone('feat')
    expect(gitIn(root)('branch', '-r').trim()).toBe('origin/feat')
    expect(await defaultAffectedBase(root, undefined)).toBe('origin/main')
    expect(await changed(root, 'origin/main')).toEqual(['b.txt', 'c.txt'])
  })

  it('fetches no blob: a stat-dirty working tree reads none of the base', async () => {
    const root = await clone('feat')
    expect(await changed(root, 'origin/main')).toEqual(['b.txt', 'c.txt'])
    const objects = gitIn(root)('count-objects', '-v')
    // Every tracked file stat-dirty: `git diff <base>` read the base's blob
    // of each changed one to drop it, fetching it (git 2.43: exit 139).
    const later = new Date(Date.now() + 5_000)
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'old/x.txt'])
      await utimes(path.join(root, f), later, later)
    expect(await changed(root, 'origin/main')).toEqual(['b.txt', 'c.txt'])
    expect(gitIn(root)('count-objects', '-v')).toBe(objects)
    expect(gitIn(root)('cat-file', '--batch-check', '--batch-all-objects')).not.toContain(
      gitIn(origin)('rev-parse', 'main:a.txt').trim(),
    )
  })

  it('fetches nothing when the clone already has the merge base', async () => {
    const root = await mkdtemp(path.join(dir, 'clone-'))
    gitIn(dir)('clone', '-q', '--depth', '20', '--no-single-branch', `file://${origin}`, root)
    gitIn(root)('checkout', '-q', 'feat')
    expect(shallow(root)).toBe('true')
    // An origin that cannot answer: any fetch would fail the diff.
    gitIn(root)('remote', 'set-url', 'origin', `file://${dir}/nowhere`)
    const before = commits(root)
    expect(await changed(root, 'origin/main')).toEqual(['b.txt', 'c.txt'])
    expect(commits(root)).toBe(before)
  })

  it('with no origin to fetch from, says the clone is shallow', async () => {
    const root = await clone('feat')
    gitIn(root)('remote', 'remove', 'origin')
    const refusal = await changed(root, 'HEAD~1').then(
      () => 'resolved',
      (err: Error) => err.message,
    )
    expect(refusal).toBe(
      'git ref "HEAD~1" did not resolve. Pass a branch or commit you have locally. ' +
        'This clone is shallow and origin did not give it: fetch the base (`git fetch --depth=1 origin <base>`).',
    )
    // The base's tip is here but not the history to its merge base: diffing
    // the tip selected what main changed, green.
    const cut = await clone('feat')
    gitIn(cut)('fetch', '-q', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main')
    gitIn(cut)('remote', 'set-url', 'origin', `file://${dir}/nowhere`)
    expect(await changed(cut, 'origin/main').catch((err: Error) => err.message)).toBe(
      'git ref "origin/main" has no merge base with HEAD in this shallow clone, and origin ' +
        'did not give the history between them: fetch it (`git fetch --unshallow origin`).',
    )
    // CONTROL: the same missing ref in a full clone keeps the bare message.
    expect(await changed(origin, 'HEAD~99').catch((err: Error) => err.message)).toBe(
      'git ref "HEAD~99" did not resolve. Pass a branch or commit you have locally.',
    )
  })
})
