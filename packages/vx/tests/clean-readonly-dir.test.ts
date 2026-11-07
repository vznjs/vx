// A task that leaves an output directory without its own write bit (`chmod
// 555 dist/ro`, as a hit restores it too) failed every later clean with
// "cannot remove declared output dist/ro/f: EACCES": vx could neither run nor
// restore the task again until someone chmodded the tree by hand. A directory
// of this user's gets owner write for the remove and its mode back after, as
// a restore's write into it does; another user's is still refused.
//
// Root bypasses the permission bits, so as root each run drops the
// capabilities that bypass them (`setpriv`); without `setpriv` root skips.

import { chmodSync, chownSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
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
  process.platform === 'win32' || (SETPRIV === null && skipAsRoot('a read-only output dir'))

async function vx(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([...DROP, process.execPath, BIN, ...args], {
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
  command = 'mkdir -p dist/ro && cat src/a > dist/ro/f && chmod 555 dist/ro',
): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-ro-dir-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(command)} },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': '1\n', '.gitignore': 'dist/\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, app }
}

it.skipIf(skip)(
  "a clean removes outputs from this user's read-only directory, on a miss and before a restore",
  async () => {
    const { root, app } = await workspace()
    const build = () => vx(root, ['run', 'build', '--all'])
    const ro = path.join(app, 'dist/ro')

    const cold = await build()
    expect(`${cold.code}\n${cold.text}`).toStartWith('0\n')

    await writeFile(path.join(app, 'src/a'), '2\n')
    const miss = await build()
    expect(`${miss.code}\n${miss.text}`).toStartWith('0\n')
    expect(readFileSync(path.join(ro, 'f'), 'utf8')).toBe('2\n')
    expect(lstatSync(ro).mode & 0o777).toBe(0o555)

    // The hit restores `dist/ro` 0555 over the miss's 0555 tree.
    await writeFile(path.join(app, 'src/a'), '1\n')
    const hit = await build()
    expect(`${hit.code}\n${hit.text}`).toStartWith('0\n')
    expect(hit.text).toContain('local 1↓')
    expect(readFileSync(path.join(ro, 'f'), 'utf8')).toBe('1\n')
    expect(lstatSync(ro).mode & 0o777).toBe(0o555)

    await writeFile(path.join(app, 'src/a'), '2\n')
    const back = await build()
    expect(`${back.code}\n${back.text}`).toStartWith('0\n')
    expect(back.text).toContain('local 1↓')
    expect(readFileSync(path.join(ro, 'f'), 'utf8')).toBe('2\n')
  },
  60_000,
)

// The clean gave the read-only directory its write back once its files
// were gone, so the prune after could not remove the subdirectory it held:
// `dist/x/s` and `dist/x` stood where the next run writes the file `dist/x`.
it.skipIf(skip)(
  "a subdirectory of this user's read-only directory goes too, on a miss and before a restore",
  async () => {
    const { root, app } = await workspace(
      'case "$(cat src/a)" in file*) printf F > dist/x;; *) mkdir -p dist/x/s; printf D > dist/x/s/y; chmod 555 dist/x;; esac',
    )
    const build = () => vx(root, ['run', 'build', '--all'])
    const x = path.join(app, 'dist/x')
    const step = async (a: string, hit: boolean): Promise<void> => {
      await writeFile(path.join(app, 'src/a'), `${a}\n`)
      const r = await build()
      expect(`${r.code}\n${r.text}`).toStartWith('0\n')
      if (hit) expect(r.text).toContain('local 1↓')
    }

    await step('dir', false)
    await step('file1', false)
    expect(readFileSync(x, 'utf8')).toBe('F')
    await step('dir', true)
    expect(readFileSync(path.join(x, 's/y'), 'utf8')).toBe('D')
    expect(lstatSync(x).mode & 0o777).toBe(0o555)
    await step('file1', true)
    expect(readFileSync(x, 'utf8')).toBe('F')
  },
  60_000,
)

// Only root can hand a directory to another user, so this row needs root
// and `setpriv` to drop the bypass.
it.skipIf(SETPRIV === null)(
  "another user's read-only directory is still refused, with the reason",
  async () => {
    const { root, app } = await workspace()
    const cold = await vx(root, ['run', 'build', '--all'])
    expect(`${cold.code}\n${cold.text}`).toStartWith('0\n')
    const ro = path.join(app, 'dist/ro')
    chownSync(ro, 65534, 65534)
    try {
      await writeFile(path.join(app, 'src/a'), '2\n')
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).toBe(1)
      expect(r.text).toContain('cannot remove declared output dist/ro/f: EACCES — ')
      expect(lstatSync(ro).mode & 0o777).toBe(0o555)
    } finally {
      chownSync(ro, 0, 0)
    }
  },
  60_000,
)
