// A file git ignored at the arm is not on the arm's inventory, so once a
// `.gitignore` edit made it an input its deletion read as a file born and
// gone since (watch-judge.ts): the key changed and no cycle ran.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'bun:test'
import { executions, startWatch, until, useWatchFixture } from './helpers/watch-loop.js'

describe('vx watch: a file .gitignore stops ignoring', () => {
  const f = useWatchFixture()

  it('is an input from then on: its deletion is a cycle', async () => {
    await writeFile(path.join(f.root, '.gitignore'), 'secret.txt\n')
    await writeFile(path.join(f.dir, 'src', 'secret.txt'), 's\n')
    f.watch = startWatch(f.root, ['--all'])
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await writeFile(path.join(f.root, '.gitignore'), '\n')
    await until(async () => (await executions(f.log)) === 2, 'the run after un-ignoring')
    await rm(path.join(f.dir, 'src', 'secret.txt'))
    // The key is the initial run's again: a hit, so the cycle is the observable.
    await until(() => w.out().includes('changed app src/secret.txt'), 'the deletion cycle')
  }, 40_000)
})
