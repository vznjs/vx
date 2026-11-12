// A cache hit restores an output (once with the mtime it was saved with),
// and the watcher hears the write. Solid (2026-10-15): `link` read every file
// beside `build`'s `**/dist/**`, so `h/dist/h.cjs` was an input by glob and
// not ignored by path; it is git-ignored, but `types` runs uncached, so an
// ignored path there counts unless the last cycle wrote it, and "wrote it"
// was read off the restored (old) mtime. An edit undone replayed `build`
// and started one more cycle: `changed solid-js h/dist/h.cjs`. `check` reads
// `build`'s outputs only where git lists them, and git ignores them whole.

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { commandWindows, run } from './helpers/orchestrator.js'
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
      build: { exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
      check: { dependsOn: ['build'], exec: { command: 'true' }, inputs: { files: ['**/*'] }, outputs: { files: [] }, cache: true },
      types: { dependsOn: ['check'], exec: { command: 'echo run >> ${log}' } },
    } }\n`,
    files: { 'src/a.txt': 'a1\n', '.gitignore': 'dist/\n' },
  })
  await writeFile(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
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

// A restore is the run's write as a command's is, and a write in a cycle
// that no command window covered was the user's (`sawEvent`). `app#types`
// opening its window within the racy window after the restore covered it
// by luck; held back here by a slow task elsewhere, as CI's event-loop
// stalls held it, the restore read as an edit and started one more cycle
// (2026-11-08).
it('a restore well before the next command starts no cycle', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-restore-held-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-restore-held-count-'))
  const log = path.join(outside, 'runs.log')
  await addProject(root, 'slow', {
    config: `export default { tasks: { types: { exec: { command: 'sleep 0.5' } } } }\n`,
  })
  const dir = await addProject(root, 'app', {
    config: `export default { tasks: {
      build: { exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
      check: { dependsOn: ['build'], exec: { command: 'true' }, inputs: { files: ['**/*'] }, outputs: { files: [] }, cache: true },
      types: { dependsOn: ['check', 'slow#types'], exec: { command: 'echo run >> ${log}' } },
    } }\n`,
    files: { 'src/a.txt': 'a1\n', '.gitignore': 'dist/\n' },
  })
  await writeFile(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
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

it("a hit's restore is a writer of the run's command windows", async () => {
  root = await makeWorkspace({ prefix: 'vx-restore-window-' })
  const dir = await addProject(root, 'app', {
    config: `export default { tasks: {
      build: { exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
    } }\n`,
    files: { 'src/a.txt': 'a1\n' },
  })
  const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  const once = { cwd: root, tasks: ['app#build'], log: silent, handleSignals: false }
  expect((await run(once)).ok).toBe(true)
  // Not the bytes the entry holds: the hit restores rather than keeps.
  const out = path.join(dir, 'dist', 'a.txt')
  await writeFile(out, 'edited\n')
  const windows = commandWindows()
  const hit = await run({ ...once, handoff: { commandWindows: windows } })
  const t = (await stat(out)).ctimeMs
  expect([hit.outcomes[0]?.status, windows.writerDuring('', out, t, t)]).toEqual([
    'cache-hit',
    'app#build',
  ])
})
