// An edit made during the initial run, to a task that already finished,
// lands before any watcher and leaves no task unsaved: watch armed over
// outputs built from the old bytes and ran nothing (watch-initial-edits).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { BIN, startWatch, until, type Watch } from './helpers/watch-loop.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
let watch: Watch | undefined
afterEach(async () => {
  watch?.proc.kill('SIGTERM')
  await watch?.proc.exited
  watch = undefined
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const libConfig = (cmd: string): string => `export default { tasks: { build: {
  exec: { command: '${cmd}' },
  inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
} } }`

/** `lib` builds at once; `app` holds the initial run until `go` exists. */
async function fixture(tracked: boolean): Promise<{ lib: string; go: string; root: string }> {
  const root = await makeWorkspace({ prefix: 'vx-watch-initial-edit-done-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-initial-edit-done-out-'))
  made.push(root, outside)
  const go = path.join(outside, 'go')
  const lib = await addProject(
    root,
    'lib',
    libConfig('mkdir -p dist && cat src/a.txt > dist/out.txt'),
  )
  await mkdir(path.join(lib, 'src'), { recursive: true })
  await writeFile(path.join(lib, 'src', 'a.txt'), 'old\n')
  await addProject(
    root,
    'app',
    `export default { tasks: { build: {
      exec: { command: 'while [ ! -f ${go} ]; do sleep 0.02; done' },
    } } }`,
  )
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  if (tracked) {
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }
  return { lib, go, root }
}

const output = (lib: string) => async (): Promise<string> =>
  readFile(path.join(lib, 'dist', 'out.txt'), 'utf8').catch(() => '')

/**
 * lib#build's row: its command's window has closed. A write inside it may
 * be the command's own, and watch cannot tell, so the edit comes after.
 */
async function finished(w: Watch, lib: string): Promise<void> {
  await until(
    async () => w.out().includes('lib#build') && (await output(lib)()) === 'old\n',
    'lib#build to finish',
  )
}

it.each([
  ['untracked', false],
  ['tracked', true],
])(
  'an edit during the initial run to a %s input of a finished task starts a cycle',
  async (_, tracked) => {
    const { lib, go, root } = await fixture(tracked)
    watch = startWatch(root, ['--all'])
    const w = watch
    const out = output(lib)
    await finished(w, lib)
    await writeFile(path.join(lib, 'src', 'a.txt'), 'new\n')
    await writeFile(go, '')
    await until(() => w.out().includes('changed lib src/a.txt'), 'a cycle for the edit')
    await until(async () => (await out()) === 'new\n', 'the output built from the edit')
  },
  40_000,
)

it('a `vx lock` during the initial run starts a cycle on the new lock', async () => {
  const { lib, go, root } = await fixture(false)
  watch = startWatch(root, ['--all'])
  const w = watch
  const out = output(lib)
  await finished(w, lib)
  await writeFile(
    path.join(lib, 'vx.config.mjs'),
    libConfig('mkdir -p dist && echo relocked > dist/out.txt'),
  )
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  expect(lock.exitCode).toBe(0)
  await writeFile(go, '')
  await until(async () => (await out()) === 'relocked\n', 'the output of the re-locked command')
  expect(w.out()).toContain('changed ')
}, 40_000)

it('a watch with no edit during the initial run starts no cycle', async () => {
  const { lib, go, root } = await fixture(true)
  await writeFile(go, '')
  watch = startWatch(root, ['--all'])
  const w = watch
  await until(() => w.out().includes('watching'), 'the watching marker')
  await until(async () => (await output(lib)()) === 'old\n', 'lib#build to finish')
  await Bun.sleep(1_000)
  expect(w.cycles()).toBe(0)
}, 40_000)
