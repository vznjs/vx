// With a dev server held, every write after the last cycle started counted
// as the server's (item 948), so three saves of one source file printed
// "a persistent task rewrites it. Add it to .gitignore". A file git tracks
// is the user's: only an untracked one is blamed on the server.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { ChangeJudge } from '../src/cli/watch-judge.js'
import { gitFiles } from '../src/cli/watch-filter.js'
import { gitInitCommit } from './helpers/workspace.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/** Three edits of `name`, each judged after a cycle that left a server up; what the judge printed. */
async function threeEdits(name: string): Promise<string[]> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-blame-'))
  await writeFile(path.join(dir, 'app.ts'), 'v0\n')
  gitInitCommit(dir)
  // Listed at the arm, untracked: the tag, not absence, must tell it apart.
  await writeFile(path.join(dir, 'server.log'), 'boot\n')
  const atArm = gitFiles(dir)!
  expect(atArm.listed.has(path.join(dir, 'server.log'))).toBe(true)
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
  try {
    for (let i = 1; i <= 3; i++) {
      judge.lastCycle = { start: Date.now() - 1000, end: Date.now() - 500 }
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
    'vx watch: server.log has started 3 cycles in a row, written while a server the cycle before started was running — a persistent task rewrites it. Add it to .gitignore (a git-ignored path never starts a cycle); until then every write restarts the server.\n',
  ])
})
