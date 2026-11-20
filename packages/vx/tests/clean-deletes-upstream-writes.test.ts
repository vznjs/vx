// A cached task's pre-run clean deletes every file its outputs match. When a
// dependency of the same project ran earlier in the run and wrote into those
// outputs without declaring them (ngrx: `build-package`, an ng-packagr step
// with no outputs, then `build` over `dist/**`), the clean silently took its
// files and the dependant failed on a missing file with no word why. vx does
// not keep the files (the config is wrong, the user fixes it): it names the
// task that wrote them, so the user can declare them.

import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

async function vx(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
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

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function workspace(): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-clean-upstream-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    config: `export default { tasks: {
      gen: { exec: { command: 'mkdir -p dist && cat src/a > dist/a.txt' }, },
      build: {
        dependsOn: ['gen'],
        exec: { command: 'cat dist/a.txt > dist/b.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
    } }`,
    files: { 'src/a': '1\n', '.gitignore': 'dist/\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, app }
}

it('a clean that deletes files a same-project dependency wrote this run names them', async () => {
  const { root } = await workspace()
  const r = await vx(root, ['run', 'app#build'])
  expect(r.code).not.toBe(0)
  expect(r.text).toContain(
    "app#build: its outputs' clean before it ran deleted dist/a.txt, which app#gen wrote earlier in this run",
  )
})

it('a dependency that writes outside the outputs draws no warning', async () => {
  const root = await makeWorkspace({ prefix: 'vx-clean-upstream-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    config: `export default { tasks: {
      gen: { exec: { command: 'mkdir -p gen && cat src/a > gen/a.txt' } },
      build: {
        dependsOn: ['gen'],
        exec: { command: 'mkdir -p dist && cat gen/a.txt > dist/b.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
    } }`,
    files: { 'src/a': '1\n', '.gitignore': 'dist/\ngen/\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  expect((await vx(root, ['run', 'app#build'])).code).toBe(0)
  // A second miss cleans the last run's dist/b.txt, older than this run: silent.
  await Bun.write(path.join(app, 'src/a'), '2\n')
  const r = await vx(root, ['run', 'app#build'])
  expect(r.code).toBe(0)
  expect(existsSync(path.join(app, 'dist/b.txt'))).toBe(true)
  expect(r.text).not.toContain("outputs' clean before it ran deleted")
})
