// A cache hit restores an output with the mtime it was saved with, and the
// watcher hears the write. Solid (M, 2026-10-15): `link` read every file
// beside `build`'s `**/dist/**`, so `h/dist/h.cjs` was an input by glob and
// not ignored by path; it is git-ignored, but `types` runs uncached, so an
// ignored path there counts unless the last cycle wrote it, and "wrote it"
// was read off the restored (old) mtime. An edit undone replayed `build`
// and started one more cycle: `changed solid-js h/dist/h.cjs`. A reader
// over another task's outputs is what `upfrontKeys: false` allows.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import {
  executions,
  initialOnly,
  SETTLE_MS,
  startWatch,
  until,
  type Watch,
} from './helpers/watch-loop.js'

let root = ''
let outside = ''
let w: Watch | undefined
afterEach(async () => {
  if (w !== undefined) {
    w.proc.kill('SIGTERM')
    await w.proc.exited
    w = undefined
  }
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

it('an output a cache hit restores starts no cycle', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-restore-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-restore-count-'))
  const log = path.join(outside, 'runs.log')
  const dir = await addProject(root, 'app', {
    config: `export default { tasks: {
      build: { exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } },
      check: { dependsOn: ['build'], exec: { command: 'true' }, inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } } },
      types: { dependsOn: ['check'], exec: { command: 'echo run >> ${log}' } },
    } }\n`,
    files: { 'src/a.txt': 'a1\n', '.gitignore': 'dist/\n' },
  })
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([], '', '{ upfrontKeys: false }'),
  )
  w = startWatch(root, ['--all'], {}, 'types')
  const watch = w
  await until(() => watch.out().includes('watching '), 'the watching marker')
  await initialOnly(watch, log)
  await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
  await until(async () => (await executions(log)) === 2, 'the edit cycle')
  await Bun.sleep(SETTLE_MS * 2)
  await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
  await until(async () => (await executions(log)) === 3, 'the undo cycle')
  await Bun.sleep(SETTLE_MS * 3)
  expect({ runs: await executions(log), out: watch.out() }).toEqual({
    runs: 3,
    out: expect.not.stringContaining('dist/a.txt'),
  })
}, 40_000)
