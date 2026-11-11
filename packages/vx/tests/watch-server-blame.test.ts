// With a dev server held, every write after the last cycle started counted
// as the server's (item 948), so three saves of one source file printed
// "a persistent task rewrites it. Add it to .gitignore". A file git tracks
// is the user's: only an untracked one is blamed on the server. Tracked
// as git says at the blame, not at the arm: a file committed since was
// blamed. And only one in a held server's own project: a new file the
// user saved in another project was.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { ChangeJudge } from '../src/cli/watch-judge.js'
import { gitFiles } from '../src/cli/watch-filter.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/**
 * Three edits of `name`, each judged after a cycle that left a server up;
 * what the judge printed. `afterArm` runs once the arm is taken; `serverDirs`
 * are the held servers' projects, relative.
 */
async function threeEdits(
  name: string,
  opts: { afterArm?: (dir: string) => Promise<void>; serverDirs?: string[] } = {},
): Promise<string[]> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-blame-'))
  await writeFile(path.join(dir, 'app.ts'), 'v0\n')
  gitInitCommit(dir)
  // Listed at the arm, untracked: the tag, not absence, must tell it apart.
  await writeFile(path.join(dir, 'server.log'), 'boot\n')
  const atArm = gitFiles(dir)!
  expect(atArm.listed.has(path.join(dir, 'server.log'))).toBe(true)
  await opts.afterArm?.(dir)
  const root = dir
  const judge = new ChangeJudge({
    workspaceRoot: dir,
    armedAt: 0,
    held: () => true,
    ...(opts.serverDirs !== undefined
      ? { serverDirs: () => opts.serverDirs!.map((d) => path.join(root, d)) }
      : {}),
    uncached: () => new Set(),
    existedAtArm: atArm.listed,
    trackedAtArm: atArm.tracked,
  })
  const printed: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk))
    return true
  })
  try {
    for (let i = 1; i <= 3; i++) {
      judge.lastCycle = { start: Date.now() - 1000, end: Date.now() - 500 }
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await writeFile(path.join(dir, name), `v${i}${'.'.repeat(i)}\n`)
      judge.pending.set(path.join(dir, name), name)
      expect(judge.judge()).toBe(name)
    }
  } finally {
    spy.mockRestore()
  }
  return printed
}

it('three saves of a tracked file under a held server blame no server', async () => {
  expect(await threeEdits('app.ts')).toEqual([])
})

// Control: an untracked file a server rewrites is still named (item 948).
it('three writes of an untracked file under a held server name it', async () => {
  expect(await threeEdits('server.log')).toEqual([
    'vx watch: server.log has started 3 cycles in a row, written while a server was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write starts a cycle.\n',
  ])
})

const SERVER_NOTICE = (name: string): string =>
  `vx watch: ${name} has started 3 cycles in a row, written while a server was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write starts a cycle.\n`

it('three saves of a file committed after the arm blame no server', async () => {
  const commit = async (root: string): Promise<void> => {
    await writeFile(path.join(root, 'new.ts'), 'v0\n')
    gitIn(root)('add', 'new.ts')
    gitIn(root)('commit', '-qm', 'new')
  }
  expect(await threeEdits('new.ts', { afterArm: commit })).toEqual([])
})

it("three saves of a new file outside the held server's project blame no server", async () => {
  expect(await threeEdits('utils/src/new.ts', { serverDirs: ['web'] })).toEqual([])
})

// Control: in the server's own project, an untracked file is still its.
it("three writes of an untracked file in the held server's project name it", async () => {
  expect(await threeEdits('web/server.log', { serverDirs: ['web'] })).toEqual([
    SERVER_NOTICE('web/server.log'),
  ])
})

// A server's log stamped to the second (`date +%s`) rewrites the same
// bytes several times a second. Each such write is judged, finds nothing
// changed and starts no cycle, and it reset the streak: the storm ran on
// and was never named (14 cycles in 15 s, no notice).
it('a same-bytes rewrite between a server’s changes leaves its streak counting', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-blame-'))
  await writeFile(path.join(dir, 'app.ts'), 'v0\n')
  gitInitCommit(dir)
  const log = path.join(dir, 'server.log')
  await writeFile(log, 'boot\n')
  const atArm = gitFiles(dir)!
  const judge = new ChangeJudge({
    workspaceRoot: dir,
    armedAt: 0,
    held: () => true,
    uncached: () => new Set(),
    existedAtArm: atArm.listed,
    trackedAtArm: atArm.tracked,
  })
  const printed: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk))
    return true
  })
  const judged: (string | undefined)[] = []
  try {
    for (let i = 1; i <= 3; i++) {
      judge.lastCycle = { start: Date.now() - 1000, end: Date.now() - 500 }
      for (const _ of [0, 1]) {
        await writeFile(log, `t${i}\n`)
        judge.pending.set(log, 'server.log')
        judged.push(judge.judge())
      }
    }
  } finally {
    spy.mockRestore()
  }
  expect(judged).toEqual([
    'server.log',
    undefined,
    'server.log',
    undefined,
    'server.log',
    undefined,
  ])
  expect(printed).toEqual([
    'vx watch: server.log has started 3 cycles in a row, written while a server was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write starts a cycle.\n',
  ])
})
