// An empty directory holds nothing a key reads: `mkdir src/new` ran a cycle
// that could change nothing under the OS watcher, where the poller, which
// samples files, ran none. A file in it is the edit.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch: an empty directory', () => {
  const f = useWatchFixture()

  it('made in a project starts no cycle; a file in it does', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await mkdir(path.join(f.dir, 'src', 'new'))
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
    await writeFile(path.join(f.dir, 'src', 'new', 'b.txt'), 'b\n')
    await until(async () => (await executions(f.log)) === 2, 'the run for the file in it')
    expect(w.out()).toContain(`changed app ${path.join('src', 'new', 'b.txt')}`)
  }, 40_000)
})
