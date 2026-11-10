// An input under a directory this user may enter but not list (`chmod 111
// src/locked`) was in no key: git warns "could not open directory" and
// exits 0, and the warning was skipped as for a directory no task can read.
// A task reads the file there by name, so an edit to it was a stale hit.
// The ignored-input walk stopped there too, told as a write.
//
// Root bypasses the permission bits, so as root each run drops the
// capabilities that bypass them (`setpriv`); without `setpriv` root skips.

import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')
const ROOT = process.getuid?.() === 0
const SETPRIV = ROOT ? Bun.which('setpriv') : null
const CAPS = '-dac_override,-dac_read_search,-fowner'
const DROP = SETPRIV === null ? [] : [SETPRIV, `--bounding-set=${CAPS}`, `--inh-caps=${CAPS}`, '--']
const skip =
  process.platform === 'win32' || (SETPRIV === null && skipAsRoot('an unlistable input dir'))

async function vx(cwd: string): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([...DROP, process.execPath, BIN, 'run', 'build', '--all'], {
    cwd,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: `${out}${err}` }
}

function rmTree(dir: string): void {
  const open = (d: string): void => {
    const st = lstatSync(d, { throwIfNoEntry: false })
    if (st === undefined || !st.isDirectory()) return
    chmodSync(d, 0o700)
    for (const n of readdirSync(d)) open(path.join(d, n))
  }
  open(dir)
  rmSync(dir, { recursive: true, force: true })
}

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmTree(d)
})

async function workspace(
  inputs: string[],
  ignore: string,
  read: string,
): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-unlisted-in-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(`mkdir -p dist && cat ${read} > dist/o`)} },
      inputs: { files: ${JSON.stringify(inputs)} }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': '1\n', '.gitignore': ignore },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, app }
}

async function lockedFile(dir: string, mode: number): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'f'), 'v1\n')
  chmodSync(dir, mode)
  return path.join(dir, 'f')
}

it.skipIf(skip)(
  'an input under a directory this user may enter but not list refuses the run, by name',
  async () => {
    const { root, app } = await workspace(['src/**'], 'dist/\n', 'src/locked/f')
    await lockedFile(path.join(app, 'src/locked'), 0o111)
    const r = await vx(root)
    expect(r.code).toBe(1)
    expect(r.text).toContain(
      'git could not list the directory packages/app/src/locked/: it can be entered but not read, so no key would see the files under it',
    )
    // Listable again, the file is an input: an edit misses.
    chmodSync(path.join(app, 'src/locked'), 0o755)
    const cold = await vx(root)
    expect(`${cold.code}\n${cold.text}`).toStartWith('0\n')
    await writeFile(path.join(app, 'src/locked/f'), 'v2\n')
    const edit = await vx(root)
    expect(`${edit.code}\n${edit.text}`).toStartWith('0\n')
    expect(edit.text).not.toContain('local 1↓')
    expect(readFileSync(path.join(app, 'dist/o'), 'utf8')).toBe('v2\n')
  },
  60_000,
)

// Control: a directory this user may not enter holds nothing a task of
// theirs reads, and stays out of the key without stopping the run.
it.skipIf(skip)(
  'a directory this user may not enter is still left out',
  async () => {
    const { root, app } = await workspace(['src/**'], 'dist/\n', 'src/a')
    await lockedFile(path.join(app, 'src/locked'), 0o000)
    const r = await vx(root)
    expect(`${r.code}\n${r.text}`).toStartWith('0\n')
  },
  60_000,
)

it.skipIf(skip)(
  'an ignored input under a directory this user cannot list refuses the key, by name',
  async () => {
    const { root, app } = await workspace(['src/**', 'gen/**'], 'dist/\ngen/\n', 'gen/locked/f')
    await lockedFile(path.join(app, 'gen/locked'), 0o111)
    const r = await vx(root)
    expect(r.code).toBe(1)
    expect(r.text).toContain(
      'cannot list input directory gen/locked: EACCES — no key would see the files under it; give this user read and search permission on it (chmod u+rx), or stop declaring it as an input',
    )
  },
  60_000,
)
