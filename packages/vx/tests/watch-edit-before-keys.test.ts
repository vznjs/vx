// An input edited after the judgement that starts a cycle and before the
// cycle keys it, then put back while the cycle still runs: the task keyed
// and built the edit, its key matched what it read (no drift), and the put-
// back settled to the state the judgement recorded, so no cycle followed.
// Watch sat green over output built from bytes no longer on disk. Gates
// place each write: `lib#build`'s runtime probe holds its key after the
// files are listed and before they are hashed, and `app#build` holds the
// cycle after `lib#build` ran. Neither writes in `lib`.

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

it('an input edited before its key and put back during the cycle starts the next cycle', async () => {
  const root = await makeWorkspace({ prefix: 'vx-watch-edit-before-keys-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-edit-before-keys-out-'))
  made.push(root, outside)
  const gate = path.join(outside, 'gate')
  const at = (f: string): string => path.join(outside, f)
  // While `gate` exists, a gated command says `<name>.started` and waits for `<name>.go`.
  const held = (name: string): string =>
    `if [ -f ${gate} ]; then touch ${at(`${name}.started`)}; while [ ! -f ${at(`${name}.go`)} ]; do sleep 0.02; done; fi`
  const lib = await addProject(
    root,
    'lib',
    `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/x.txt > dist/out.txt' },
      inputs: { files: ['src/**'], runtime: ['${held('key')}'] },
      outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
  )
  await addProject(
    root,
    'app',
    `export default { tasks: { build: { exec: { command: '${held('after')}' }, inputs: { files: ['src/**'] }, dependsOn: ['lib#build'] } } }`,
  )
  const src = path.join(lib, 'src', 'x.txt')
  const out = (): Promise<string> =>
    readFile(path.join(lib, 'dist', 'out.txt'), 'utf8').catch(() => '')
  await mkdir(path.join(lib, 'src'), { recursive: true })
  await writeFile(src, 'one\n')
  watch = startWatch(root, ['--all'])
  const w = watch
  await until(() => w.out().includes('watching '), 'the watching marker')
  await until(async () => (await out()) === 'one\n', 'the initial build')

  await writeFile(gate, '')
  await writeFile(src, 'two\n')
  await until(() => Bun.file(at('key.started')).exists(), 'the cycle for two to key lib#build')
  // After the judgement that recorded two, before lib#build's key hashes it.
  await writeFile(src, 'three\n')
  await writeFile(at('key.go'), '')
  await until(() => Bun.file(at('after.started')).exists(), 'lib#build to run')
  await until(async () => (await out()) === 'three\n', 'lib#build to build three')
  // Back to two, the state that judgement recorded, while the cycle runs.
  await writeFile(src, 'two\n')
  await rm(gate)
  await writeFile(at('after.go'), '')
  await until(async () => (await out()) === 'two\n', 'the output built from two again', 20_000)
}, 60_000)
