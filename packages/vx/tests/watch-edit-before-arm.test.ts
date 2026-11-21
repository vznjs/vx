// An edit to a clean tracked input after watch asked git what is dirty and
// before its watchers armed reached neither: git had not named it, no
// watcher heard it, and watch idled over output built from the old bytes
// (fuzzwi seed 961: "8 tasks cached, nothing ran", then a save was lost).
// A `git` on PATH makes the edit land in that gap: it answers the arm's
// inventory, then writes the file before watch sees the answer.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { startWatch, until, type Watch } from './helpers/watch-loop.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
let watch: Watch | undefined
afterEach(async () => {
  watch?.proc.kill('SIGTERM')
  await watch?.proc.exited
  watch = undefined
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

it('an edit landing between the arm inventory and the watchers starts a cycle', async () => {
  const root = await makeWorkspace({ prefix: 'vx-watch-edit-before-arm-' })
  const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-edit-before-arm-bin-'))
  made.push(root, bin)
  const lib = await addProject(
    root,
    'lib',
    `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
  )
  await mkdir(path.join(lib, 'src'), { recursive: true })
  const input = path.join(lib, 'src', 'a.txt')
  await writeFile(input, 'old\n')
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')

  const flag = path.join(bin, 'edit-once')
  await writeFile(flag, '')
  const real = Bun.which('git')!
  const shim = path.join(bin, 'git')
  // The arm's inventory is the one `ls-files -t … -m` call.
  await writeFile(
    shim,
    `#!/bin/sh
case " $* " in
  *" ls-files "*" -t "*" -m"*)
    if [ -f '${flag}' ]; then
      '${real}' "$@" > '${bin}/answer'; rc=$?
      rm -f '${flag}'
      printf 'new\\n' > '${input}'
      cat '${bin}/answer'; exit $rc
    fi ;;
esac
exec '${real}' "$@"
`,
  )
  await chmod(shim, 0o755)

  watch = startWatch(root, ['--all'], { PATH: `${bin}:${process.env.PATH}` })
  const w = watch
  await until(() => w.out().includes('watching'), 'the watching marker')
  expect(await readFile(input, 'utf8')).toBe('new\n')
  const out = async (): Promise<string> =>
    readFile(path.join(lib, 'dist', 'out.txt'), 'utf8').catch(() => '')
  await until(async () => (await out()) === 'new\n', 'the output built from the edit')
}, 40_000)
