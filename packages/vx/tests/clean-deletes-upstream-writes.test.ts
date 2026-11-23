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
import { vx } from './helpers/vx.js'

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

// transloco (Nx): `build-package` (ng-packagr, no outputs) writes the
// workspace's dist/libs/transloco, then `build` declares that root-anchored
// path as its output; its clean took the package with no word, and every
// dependant failed on types it could not find.
it('a workspace-output clean that deletes a same-project dependency’s writes names them', async () => {
  const root = await makeWorkspace({ prefix: 'vx-clean-upstream-ws-' })
  made.push(root)
  const top = '"$(git rev-parse --show-toplevel)"'
  await addProject(root, 'app', {
    config: `export default { tasks: {
      gen: { exec: { command: 'mkdir -p ${top}/dist/app && cat src/a > ${top}/dist/app/a.txt' } },
      build: {
        dependsOn: ['gen'],
        exec: { command: 'cat ${top}/dist/app/a.txt > ${top}/dist/app/b.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['dist/app'] }, cache: true,
      },
    } }`,
    files: { 'src/a': '1\n' },
  })
  await Bun.write(path.join(root, '.gitignore'), 'dist/\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const r = await vx(root, ['run', 'app#build'])
  expect(r.code).not.toBe(0)
  expect(r.text).toContain(
    "app#build: its outputs' clean before it ran deleted dist/app/a.txt, which app#gen wrote earlier in this run",
  )
})
