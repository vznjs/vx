// A declared output git tracks counts as an edit (a downstream task reads
// it), so a cycle that restores or rebuilds it starts the next one. After
// three such cycles the notice said "Declare it in outputs", but it was
// declared: the fix it offered changed nothing (committed-output flip,
// 2026-11-18).

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

async function threeCycles(name: string, declared: boolean): Promise<string[]> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-output-'))
  const abs = path.join(dir, name)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, 'v0\n')
  gitInitCommit(dir)
  gitIn(dir)('add', '-A')
  gitIn(dir)('commit', '-qm', 'output', '--allow-empty')
  const atArm = gitFiles(dir)!
  expect(atArm.tracked.has(abs)).toBe(true)
  const judge = new ChangeJudge({
    workspaceRoot: dir,
    armedAt: 0,
    held: () => false,
    uncached: () => new Set(),
    existedAtArm: atArm.listed,
    trackedAtArm: atArm.tracked,
    declaredOutput: (p) => declared && p === abs,
  })
  const printed: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk))
    return true
  })
  try {
    for (let i = 1; i <= 3; i++) {
      judge.lastCycle = { start: Date.now() - 1000, end: Date.now() + 1000 }
      await writeFile(abs, `v${i}${'.'.repeat(i)}\n`)
      judge.pending.set(abs, name)
      expect(judge.judge()).toBe(name)
    }
  } finally {
    spy.mockRestore()
  }
  return printed
}

it('a declared output git tracks is told to leave git, not to be declared', async () => {
  expect(await threeCycles('dist/app.js', true)).toEqual([
    'vx watch: dist/app.js has started 3 cycles in a row, written by the cycle before each. It is a declared output, but git tracks it, so each write counts as an edit. Add it to .gitignore and remove it from git (git rm --cached); until then every run re-runs.\n',
  ])
})

// Control: an undeclared file a task rewrites keeps the old advice.
it('an undeclared file a task rewrites is still told to declare it', async () => {
  expect(await threeCycles('gen/out.txt', false)).toEqual([
    'vx watch: gen/out.txt has started 3 cycles in a row, written by the cycle before each — a task rewrites it every run. Declare it in outputs (an output never starts a cycle) or add it to .gitignore (a git-ignored path never does); until then every run re-runs.\n',
  ])
})
