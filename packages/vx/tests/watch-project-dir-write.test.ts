// A project's directory is watched from its parent too, to hear it removed
// and made again. On macOS that arm also hears the directory's own mtime
// move whenever an entry in it is written, so a cycle whose task wrote at
// the project's top level (solid's `types`, M 2026-10-15) started a second
// cycle named after the directory. The project's own arm judges its
// contents; the parent's judges only the directory being another one.
// `touch .` is the same event on Linux: an attribute change on the entry.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
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

it('a task touching its project directory starts no second cycle', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-dir-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-dir-count-'))
  const log = path.join(outside, 'runs.log')
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt && touch . && echo run >> ${log}' } } } }\n`,
  )
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
  await writeFile(path.join(dir, '.gitignore'), 'out.txt\n')
  w = startWatch(root)
  const watch = w
  await until(() => watch.out().includes('watching '), 'the watching marker')
  await initialOnly(watch, log)
  await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
  await until(async () => (await executions(log)) === 2, 'the edit cycle')
  await Bun.sleep(SETTLE_MS * 2)
  expect({ runs: await executions(log), out: watch.out() }).toEqual({
    runs: 2,
    out: expect.not.stringContaining('changed packages/app'),
  })
}, 40_000)
