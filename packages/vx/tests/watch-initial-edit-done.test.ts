// An edit made during the initial run, to a task that already finished,
// lands before any watcher and leaves no task unsaved: watch armed over
// outputs built from the old bytes and ran nothing (watch-initial-edits).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { startWatch, until, type Watch } from './helpers/watch-loop.js'
import { BIN } from './helpers/vx.js'
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
async function finished(w: Watch, lib: string, row = 'lib#build'): Promise<void> {
  await until(
    async () => w.out().includes(row) && (await output(lib)()) === 'old\n',
    `${row} to finish`,
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

/** `lib#lint` is done at once; `lib#hold`, behind it, holds the run until `go` exists, then writes a file. */
async function oneProject(): Promise<{ lib: string; go: string; root: string }> {
  const root = await makeWorkspace({ prefix: 'vx-watch-initial-edit-done-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-initial-edit-done-out-'))
  made.push(root, outside)
  const go = path.join(outside, 'go')
  const lib = await addProject(
    root,
    'lib',
    `export default { tasks: {
      lint: {
        exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
      hold: {
        exec: { command: 'while [ ! -f ${go} ]; do sleep 0.02; done; echo held > held.txt' },
        dependsOn: ['lint'],
      },
    } }`,
  )
  await mkdir(path.join(lib, 'src'), { recursive: true })
  await writeFile(path.join(lib, 'src', 'a.txt'), 'old\n')
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  return { lib, go, root }
}

// A write while a command of the same project runs may be that command's,
// so it was dropped: `lint` was done, `hold` was running, and the edit to
// lint's input waited for the next save. The keys tell: one moved.
it('an edit to a finished task, made while another task of its project runs, starts a cycle', async () => {
  const { lib, go, root } = await oneProject()
  watch = startWatch(root, ['--all'], {}, 'hold')
  const w = watch
  const out = output(lib)
  await finished(w, lib, 'lib#lint')
  await writeFile(path.join(lib, 'src', 'a.txt'), 'new\n')
  await writeFile(go, '')
  await until(async () => (await out()) === 'new\n', 'the output built from the edit')
}, 40_000)

// CONTROL: the command's own write, in its window, moves no key.
it('a file the initial run wrote in its own project starts no cycle', async () => {
  const { lib, go, root } = await oneProject()
  watch = startWatch(root, ['--all'], {}, 'hold')
  const w = watch
  await finished(w, lib, 'lib#lint')
  await writeFile(go, '')
  await until(() => w.out().includes('watching'), 'the watching marker')
  expect(await readFile(path.join(lib, 'held.txt'), 'utf8')).toBe('held\n')
  await Bun.sleep(1_000)
  expect(w.cycles()).toBe(0)
}, 40_000)

/** `fixture(true)` with a second tracked source, and a `lib#build` that reads every source. */
async function twoSources(): Promise<{ lib: string; go: string; root: string }> {
  const f = await fixture(false)
  await writeFile(
    path.join(f.lib, 'vx.config.mjs'),
    libConfig('mkdir -p dist && cat src/*.txt > dist/out.txt'),
  )
  await writeFile(path.join(f.lib, 'src', 'b.txt'), 'more\n')
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: f.root,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  expect(lock.exitCode).toBe(0)
  const git = gitIn(f.root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return f
}

// A deletion has no date to tell it from one made before the start, so it
// was never heard. The keys tell: the run's own saw the file.
it('a tracked input deleted during the initial run, after its task finished, starts a cycle', async () => {
  const { lib, go, root } = await twoSources()
  watch = startWatch(root, ['--all'])
  const out = output(lib)
  await until(async () => (await out()) === 'old\nmore\n', 'lib#build to finish')
  await rm(path.join(lib, 'src', 'b.txt'))
  await writeFile(go, '')
  await until(async () => (await out()) === 'old\n', 'the output built without the file')
}, 40_000)

// CONTROL: the run keyed the tree without the file; no key moved.
it('a tracked input deleted before the start starts no cycle', async () => {
  const { lib, go, root } = await twoSources()
  await rm(path.join(lib, 'src', 'b.txt'))
  await writeFile(go, '')
  watch = startWatch(root, ['--all'])
  const w = watch
  await until(() => w.out().includes('watching'), 'the watching marker')
  await until(async () => (await output(lib)()) === 'old\n', 'lib#build to finish')
  await Bun.sleep(1_000)
  expect(w.cycles()).toBe(0)
}, 40_000)

// Committed, the edit is no longer dirty: git names no file, and the output
// stayed built from the old bytes. Git's index moved, so the keys judge.
it('an edit committed during the initial run, after its task finished, starts a cycle', async () => {
  const { lib, go, root } = await fixture(true)
  watch = startWatch(root, ['--all'])
  const w = watch
  const out = output(lib)
  await finished(w, lib)
  await writeFile(path.join(lib, 'src', 'a.txt'), 'new\n')
  gitIn(root)('commit', '-q', '-a', '-m', 'edit')
  await writeFile(go, '')
  await until(async () => (await out()) === 'new\n', 'the output of the committed bytes')
  expect(w.out()).toContain('changed files, committed or checked out during the first run')
}, 40_000)

it('a branch checked out during the initial run, after its task finished, starts a cycle', async () => {
  const { lib, go, root } = await fixture(true)
  const git = gitIn(root)
  git('checkout', '-q', '-b', 'other')
  await writeFile(path.join(lib, 'src', 'a.txt'), 'other\n')
  git('commit', '-q', '-a', '-m', 'other')
  git('checkout', '-q', '-')
  watch = startWatch(root, ['--all'])
  const out = output(lib)
  await finished(watch, lib)
  git('checkout', '-q', 'other')
  await writeFile(go, '')
  await until(async () => (await out()) === 'other\n', 'the output of the other branch')
}, 40_000)

// CONTROL: the index moved and no key did.
it('a commit during the initial run that moves no key starts no cycle', async () => {
  const { lib, go, root } = await fixture(true)
  watch = startWatch(root, ['--all'])
  const w = watch
  await finished(w, lib)
  gitIn(root)('commit', '-q', '--allow-empty', '-m', 'empty')
  await writeFile(path.join(root, 'notes.txt'), 'x\n')
  gitIn(root)('add', 'notes.txt')
  await writeFile(go, '')
  await until(() => w.out().includes('watching'), 'the watching marker')
  await Bun.sleep(1_500)
  expect(w.cycles()).toBe(0)
  expect(await output(lib)()).toBe('old\n')
}, 40_000)

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
