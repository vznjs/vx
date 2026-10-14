// vx's own files under `.vx` (the workspace config, the lock, their ignore
// and attributes files) and each config's `vx.lock.json` are never a task's
// output. They left the never-list with the move into `.vx` (#3529), and a
// root task whose outputs reached them deleted them in the clean before a
// run (an uncommitted workspace config: the next run found no workspace),
// and a hit restored saved bytes over the current ones: the ignore and
// attributes files and the lock are outside the key (#3532), so an edit to
// them was reverted.
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'

it(
  'the clean never deletes a .vx file, and a hit never restores one',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-output-dotvx-' })
    try {
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            gen: {
              exec: { command: 'mkdir -p out && echo x > out/x' },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out/**', '.vx/**'] } },
            },
          },
        }\n`,
      )
      const ignore = path.join(root, '.vx', '.gitignore')
      await writeFile(ignore, '/cache\n')
      const first = await summarized(root, ['fixture-root#gen'])
      expect(first.code).toBe(0)
      expect(await Bun.file(path.join(root, '.vx', 'workspace.mjs')).exists()).toBe(true)
      await writeFile(ignore, '/cache\n/scratch\n')
      await rm(path.join(root, 'out'), { recursive: true, force: true })
      const second = await summarized(root, ['fixture-root#gen'])
      expect(second.tasks.get('fixture-root#gen')?.['status']).toBe('cache-hit')
      expect(await readFile(ignore, 'utf8')).toBe('/cache\n/scratch\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
