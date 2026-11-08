// The resolved cache dir is never an edit (cli.md § Path filtering), and
// that holds for the dir the workspace config names NOW. The loop took the
// dir once, at start: `cache.dir` moved mid-watch, the cycle under the new
// config wrote its store into a watched project, and outside a git tree
// each write started the next cycle, for good.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  SETTLE_MS,
  ARMS,
  arms,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch and a cache dir moved mid-watch', () => {
  const f = useWatchFixture()

  it("the new dir's writes start no cycle", async () => {
    // Named by the config, not by the suite's VX_CACHE_DIR, which outranks it.
    const wsFile = path.join(f.root, '.vx/workspace.mjs')
    const source = await Bun.file(wsFile).text()
    const withDir = (dir: string): string =>
      source.replace(
        'export default { ',
        `export default { cache: { dir: ${JSON.stringify(dir)} }, `,
      )
    await writeFile(wsFile, withDir('.vx/cache'))
    f.watch = startWatch(f.root, ['--all'], { ...ARMS, VX_CACHE_DIR: '' })
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(wsFile, withDir(path.join(f.dir, 'vxc')))
    await until(() => w.cycles() === 1, 'the cycle under the new config')
    await until(() => arms(w) === 2, 'the re-arm after it')
    await Bun.sleep(SETTLE_MS)
    expect(w.out()).not.toContain('changed app vxc')
    expect(w.cycles()).toBe(1)
    // Control: the loop still hears an edit.
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(() => w.cycles() === 2, 'the edit cycle')
    expect(w.out()).toContain('changed app src/a.txt')
  }, 40_000)
})
