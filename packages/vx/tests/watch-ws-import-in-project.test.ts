// A file the workspace config imports is loaded once per process, so its
// edit is named with the restart it needs (item 949). Inside a watched
// project's tree — any repo whose root is a project — the project's arm
// heard it instead, and a cycle ran the stale config without a word.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'bun:test'
import { initialOnly, startWatch, until, useWatchFixture } from './helpers/watch-loop.js'

describe('vx watch: a workspace config import inside a project', () => {
  const f = useWatchFixture()

  it('is named with the restart it needs', async () => {
    await writeFile(path.join(f.root, 'vx.config.mjs'), "export default { name: 'root' }\n")
    await writeFile(path.join(f.root, 'ws-helper.mjs'), "export const msg = 'ONE'\n")
    await Bun.write(
      path.join(f.root, '.vx/workspace.mjs'),
      "import { msg } from '../ws-helper.mjs'\nexport default { plugins: [] }\n",
    )
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching 2 projects'), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.root, 'ws-helper.mjs'), "export const msg = 'TWO'\n")
    await until(
      () => w.out().includes('ws-helper.mjs changed; the workspace config imports it'),
      'the restart notice',
    )
  }, 40_000)
})
