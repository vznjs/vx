// macOS FSEvents can split one `git checkout` into batches past a debounce
// window. The first half started a cycle whose run read the whole tree;
// the late half, each a first sighting stamped after the arm, started a
// second cycle with nothing changed (macOS CI, 2026-11-12). A first
// sighting is judged against the last run's start, not the arm.

import { statSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { ChangeJudge } from '../src/cli/watch-judge.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

async function setup(rereadPending = false) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-watch-late-')))
  const judge = new ChangeJudge({
    workspaceRoot: dir,
    armedAt: 0,
    held: () => false,
    uncached: () => new Set(),
    rereadPending: () => rereadPending,
  })
  return { root: dir, judge }
}

/** Writes `name`; returns when, on the file's own clock (no process sets a ctime, so runs are placed around it). */
async function fileAt(root: string, name: string): Promise<number> {
  const abs = path.join(root, name)
  await writeFile(abs, `${name}\n`)
  const st = statSync(abs)
  return Math.max(st.mtimeMs, st.ctimeMs)
}

it('a late event for a file written before the last run began starts no cycle', async () => {
  const { root, judge } = await setup()
  const written = await fileAt(root, 'f10.txt')
  judge.lastCycle = { start: written + 1_000, end: written + 2_000 }
  judge.pending.set(path.join(root, 'f10.txt'), 'app src/f10.txt')
  expect(judge.judge()).toBeUndefined()
})

it('CONTROL: a file written after the last run began starts one', async () => {
  const { root, judge } = await setup()
  const written = await fileAt(root, 'f10.txt')
  judge.lastCycle = { start: written - 1_000, end: written + 1_000 }
  judge.pending.set(path.join(root, 'f10.txt'), 'app src/f10.txt')
  expect(judge.judge()).toBe('app src/f10.txt')
})

it('CONTROL: a write within the racy window before the run began starts one', async () => {
  // Stamped up to a tick behind the clock, it may have landed after the
  // run's start, and the run may not have read it.
  const { root, judge } = await setup()
  const written = await fileAt(root, 'f10.txt')
  judge.lastCycle = { start: written + 10, end: written + 1_000 }
  judge.pending.set(path.join(root, 'f10.txt'), 'app src/f10.txt')
  expect(judge.judge()).toBe('app src/f10.txt')
})

it('CONTROL: with a re-read pending, only the arm counts', async () => {
  // Only a cycle re-reads the watched set: let off as read by the run, a
  // late lock or new member was never armed.
  const { root, judge } = await setup(true)
  const written = await fileAt(root, 'f10.txt')
  judge.lastCycle = { start: written + 1_000, end: written + 2_000 }
  judge.pending.set(path.join(root, 'f10.txt'), 'app src/f10.txt')
  expect(judge.judge()).toBe('app src/f10.txt')
})

it('CONTROL: before any run, the arm decides', async () => {
  const { root, judge } = await setup()
  await fileAt(root, 'f10.txt')
  judge.pending.set(path.join(root, 'f10.txt'), 'app src/f10.txt')
  expect(judge.judge()).toBe('app src/f10.txt')
})
