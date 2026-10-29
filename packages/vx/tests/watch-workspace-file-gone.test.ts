// The workspace file marks the root: with it gone, `vx run` refuses, and a
// watch cycle did not — it ran on with no workspace config, its plugins
// gone, the task under another name (`packages/app#build`).

import { rm, writeFile } from 'node:fs/promises'
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

describe('vx watch: the workspace file removed', () => {
  const f = useWatchFixture()

  it('a cycle refuses as a run would, and runs again once it is back', async () => {
    f.watch = startWatch(f.root, ['--all'])
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    const ws = path.join(f.root, '.vx', 'workspace.mjs')
    const source = await Bun.file(ws).text()
    await rm(ws)
    await until(() => w.cycles() === 1, 'the cycle the removal starts')
    await until(() => w.err().includes('no .vx/workspace.ts'), 'the refusal')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(1)
    expect(w.out()).not.toContain('packages/app#build')

    await writeFile(ws, source)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'back\n')
    await until(async () => (await executions(f.log)) === 2, 'the run once it is back')
  }, 40_000)
})
