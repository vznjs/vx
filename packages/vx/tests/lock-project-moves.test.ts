// A project renamed, deleted, moved to a new folder or renamed in its
// package.json: a run refuses or `--check` names it, `vx lock` settles it,
// and a second `vx lock` changes no byte of either lock.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { BIN, vxSync } from './helpers/vx.js'

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args, { bin: BIN })
const config = (c: string) =>
  `export default { tasks: { build: { dependsOn: ['^build'], exec: { command: '${c}' } } } }\n`

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const locks = async (r: string) =>
  (await Bun.file(path.join(r, '.vx/projects.lock')).text()) +
  (await Bun.file(path.join(r, '.vx/dependencies.lock')).text())

const cases: [string, (r: string) => Promise<unknown>, string, string][] = [
  [
    'a project directory renamed',
    (r) => rename(path.join(r, 'packages/a'), path.join(r, 'packages/a2')),
    // The new folder is no project until `vx lock`; the locked one is gone.
    'locks packages/a ("a"), but its directory is gone — run `vx lock`',
    'the lock holds packages/a, which has no vx.config now',
  ],
  [
    'a project deleted',
    (r) => rm(path.join(r, 'packages/b'), { recursive: true }),
    'locks packages/b ("b"), but its directory is gone — run `vx lock`',
    'the lock holds packages/b, which has no vx.config now',
  ],
  [
    'a project moved to a new folder the workspace globs',
    async (r) => {
      await mkdir(path.join(r, 'libs'))
      await writeFile(
        path.join(r, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "libs/*"\n',
      )
      await rename(path.join(r, 'packages/a'), path.join(r, 'libs/a'))
    },
    'locks packages/a ("a"), but its directory is gone — run `vx lock`',
    'the lock holds packages/a, which has no vx.config now',
  ],
  [
    // The package stays, so the edges plugin maps it config-less: the
    // audit said 'the lock names it "a", the plugins here "a"'.
    'a vx.config deleted, its package kept',
    (r) =>
      Promise.all(['vx.config.mjs', 'vx.lock.json'].map((f) => rm(path.join(r, 'packages/a', f)))),
    '',
    "the lock holds packages/a, which has no vx.config now ('vx-test-packages' adds it without one)",
  ],
  [
    'a package.json name changed',
    (r) =>
      writeFile(
        path.join(r, 'packages/a/package.json'),
        JSON.stringify({ name: 'a2', version: '0.0.0' }),
      ),
    // The run keeps the locked name: the `discover` stage is locked.
    '',
    'packages/a: the lock names it "a", the plugins here "a2"',
  ],
]

for (const [name, change, run, check] of cases)
  it(`${name}: refused or named, then settled by one idempotent vx lock`, async () => {
    const r = (root = await makeWorkspace({ prefix: 'vx-lock-moves-', edges: { b: ['a'] } }))
    const git = gitIn(r)
    await addProject(r, 'a', config('echo a'))
    await addProject(r, 'b', config('echo b'))
    expect(vx(r, 'lock').code).toBe(0)
    git('add', '-A')
    git('commit', '-qm', 'base')
    await change(r)
    const ran = vx(r, 'run', '--all', 'build')
    if (run === '') expect(ran.code).toBe(0)
    else expect(`${ran.code} ${ran.err}`).toContain(run)
    const checked = vx(r, 'lock', '--check')
    expect(`${checked.code} ${checked.err}`).toContain(check)
    expect(checked.code).toBe(1)
    expect(vx(r, 'lock').code).toBe(0)
    const once = await locks(r)
    expect(vx(r, 'lock').code).toBe(0)
    expect(await locks(r)).toBe(once)
    expect(vx(r, 'lock', '--check').code).toBe(0)
    expect(vx(r, 'run', '--all', 'build').code).toBe(0)
  })
