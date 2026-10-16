// A symlinked input keys the content behind it (linked-inputs.test.ts), so
// an edit there is an edit: `vx watch` armed only the project trees, and a
// link's target outside them (elsewhere in the workspace, or outside it)
// changed the key while the loop ran nothing.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'
import { gitIn } from './helpers/workspace.js'

describe('vx watch and a symlinked input', () => {
  const f = useWatchFixture()
  let outside = ''
  beforeEach(async () => {
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-linked-'))
  })
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true })
  })

  it('an edit behind a file link outside the workspace starts a cycle', async () => {
    await writeFile(path.join(outside, 'o.txt'), 'o1\n')
    await symlink(path.join(outside, 'o.txt'), path.join(f.dir, 'src', 'o.txt'))
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(outside, 'o.txt'), 'o2\n')
    await until(() => w.cycles() === 1, 'the cycle for the edit behind the link')
    expect(w.out()).toContain('changed app src/o.txt')
    await until(async () => (await executions(f.log)) === 2, 'the rebuild')
  }, 40_000)

  it('an edit behind a directory link elsewhere in the workspace starts a cycle', async () => {
    await mkdir(path.join(f.root, 'shared', 'd'), { recursive: true })
    await writeFile(path.join(f.root, 'shared', 'd', 'x.txt'), 'x1\n')
    await symlink('../../../shared/d', path.join(f.dir, 'src', 'd'))
    gitIn(f.root)('add', '-A')
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(f.root, 'shared', 'd', 'x.txt'), 'x2\n')
    await until(() => w.cycles() === 1, 'the cycle for the edit behind the link')
    expect(w.out()).toContain('changed app src/d')
  }, 40_000)

  // Control: the target rewritten with its own bytes is no change.
  it('the target rewritten with the same bytes starts nothing', async () => {
    await writeFile(path.join(outside, 'o.txt'), 'o1\n')
    await symlink(path.join(outside, 'o.txt'), path.join(f.dir, 'src', 'o.txt'))
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(outside, 'o.txt'), 'o1\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
  }, 40_000)
})
