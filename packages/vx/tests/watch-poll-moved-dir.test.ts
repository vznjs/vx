// A directory moved into an input tree is an edit: its files are new
// inputs. A rename moves only the directory's own ctime, so its files
// keep times from before the arm. The poller sampled files alone, each
// a first sighting judged by its times, and `--poll` never ran the
// cycle the native watcher did, which reports the directory itself.

import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch: a directory moved into an input tree', () => {
  const f = useWatchFixture()

  it.each([
    ['--poll', ['--all', '--poll']],
    ['the native watcher', ['--all']],
  ])(
    'with files older than the arm re-runs (%s)',
    async (_mode, select) => {
      const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-stage-'))
      try {
        await mkdir(path.join(stage, 'moved'))
        await writeFile(path.join(stage, 'moved', 'b.txt'), 'b1\n')
        f.watch = startWatch(f.root, select)
        const w = f.watch
        await until(() => w.out().includes('watching '), 'the watching marker')
        await initialOnly(w, f.log)
        await rename(path.join(stage, 'moved'), path.join(f.dir, 'src', 'moved'))
        await until(async () => (await executions(f.log)) === 2, 'the run for the moved directory')
        expect(w.out()).toContain(`changed app ${path.join('src', 'moved')}`)
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    },
    40_000,
  )
})
