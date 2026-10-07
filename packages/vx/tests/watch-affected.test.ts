// `vx watch --affected` end to end: the diff picks the scope once, at
// start; a later cycle is an edit, and the cache keys decide what runs.
// Fixture and markers: `helpers/watch-loop.ts`.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { gitIn } from './helpers/workspace.js'
import { SETTLE_MS, executions, startWatch, until, useWatchFixture } from './helpers/watch-loop.js'

describe('vx watch --affected (e2e)', () => {
  const f = useWatchFixture()

  it('an edit after the start runs the task the startup diff left out (X-37)', async () => {
    // The startup diff touches only `docs`'s input, so the initial run
    // executes nothing. Every cycle used to judge against that same diff,
    // so the `src` edit below never ran `build`.
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
        docs: {
          exec: { command: 'true' },
          cache: { inputs: { files: ['notes.md'] }, outputs: { files: [] } },
        },
      } }\n`,
    )
    await writeFile(path.join(f.dir, 'notes.md'), 'n1\n')
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(f.dir, 'notes.md'), 'n2\n')

    f.watch = startWatch(f.root, ['--affected=HEAD'])
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(await executions(f.log)).toBe(0)

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(() => w.cycles() === 1, 'the cycle the edit starts')
    await until(async () => (await executions(f.log)) === 1, 'the build the edit runs')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), runs: await executions(f.log) }).toEqual({ cycles: 1, runs: 1 })
  }, 40_000)
})
