// An input edited while a cycle runs its task, then put back to the state
// watch last judged (save, then undo and save while the build runs): the
// task read the edit, warned "the next cycle runs on it", and no cycle ran,
// since the settled file equalled what the judge last saw. Watch sat green
// over output built from bytes no longer on disk.

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

it('an input edited and put back during a cycle starts the next cycle', async () => {
  const root = await makeWorkspace({ prefix: 'vx-watch-edit-undone-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-edit-undone-out-'))
  made.push(root, outside)
  const gate = path.join(outside, 'gate')
  const started = path.join(outside, 'started')
  const go = path.join(outside, 'go')
  const read = path.join(outside, 'read')
  const done = path.join(outside, 'done')
  // Gated, the command waits for `go`, builds, says `read`, then waits for `done`.
  const wait = (f: string): string => `while [ ! -f ${f} ]; do sleep 0.02; done`
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { build: {
      exec: { command: 'if [ -f ${gate} ]; then touch ${started}; ${wait(go)}; fi; mkdir -p dist && cat src/a.txt > dist/out.txt; if [ -f ${gate} ]; then touch ${read}; ${wait(done)}; fi' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
  )
  const src = path.join(dir, 'src', 'a.txt')
  const out = (): Promise<string> =>
    readFile(path.join(dir, 'dist', 'out.txt'), 'utf8').catch(() => '')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(src, 'A\n')
  watch = startWatch(root, ['--all'])
  const w = watch
  await until(() => w.out().includes('watching '), 'the watching marker')
  await until(async () => (await out()) === 'A\n', 'the initial build')

  await writeFile(gate, '')
  await writeFile(src, 'B\n')
  await until(() => Bun.file(started).exists(), 'the cycle for B to start the task')
  await writeFile(src, 'C\n')
  await writeFile(go, '')
  await until(() => Bun.file(read).exists(), 'the task to build from C')
  // Back to B, the state the judgement that started this cycle recorded.
  await writeFile(src, 'B\n')
  await rm(gate)
  await writeFile(done, '')
  await until(() => w.err().includes('the next cycle runs on it'), 'the drift warning')
  await until(async () => (await out()) === 'B\n', 'the output built from B again', 20_000)
}, 60_000)
