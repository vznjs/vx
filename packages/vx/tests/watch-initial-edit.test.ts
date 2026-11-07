// An edit made while the initial run runs a task lands before any watcher
// is armed. The run's re-check leaves the task unsaved; watch then idled,
// its output built from the old bytes, until an unrelated edit.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'bun:test'
import { startWatch, until, type Watch } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
let watch: Watch | undefined
afterEach(async () => {
  watch?.proc.kill('SIGTERM')
  await watch?.proc.exited
  watch = undefined
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

it('an edit during the initial run starts a cycle once watch arms', async () => {
  const root = await makeWorkspace({ prefix: 'vx-watch-initial-edit-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-initial-edit-out-'))
  made.push(root, outside)
  const started = path.join(outside, 'started')
  const go = path.join(outside, 'go')
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { build: {
      exec: { command: 'touch ${started}; while [ ! -f ${go} ]; do sleep 0.02; done; mkdir -p dist && cat src/a.txt > dist/out.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
  )
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.txt'), 'old\n')
  watch = startWatch(root, ['--all'])
  const w = watch
  await until(() => Bun.file(started).exists(), 'the initial run to start the task')
  await writeFile(path.join(dir, 'src', 'a.txt'), 'new\n')
  await writeFile(go, '')
  await until(() => w.out().includes('changed app#build inputs'), 'a cycle for the edit')
  await until(
    // The cycle clears its outputs before the command: absent meanwhile.
    async () =>
      (await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8').catch(() => '')) === 'new\n',
    'the output built from the edited input',
  )
}, 40_000)
