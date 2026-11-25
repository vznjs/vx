// tldraw: build depends on build-api, whose output api-report.api.md is
// committed. The mapper dropped build's `!api-report.api.md` so its key
// would read the committed file, but build's key folds build-api's, and core
// refuses a key reading the outputs of a task it folds: `vx lock` refused
// 17 packages. The `!` stays and build stays cached.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE = path.resolve(import.meta.dir, '../node_modules/.bin/vx')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

it('a reader after the writer of a committed output keeps its `!`: vx lock passes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-folded-'))
  roots.push(root)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const put = async (rel: string, body: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
  await put('package.json', '{"name":"r","workspaces":["packages/*"]}\n')
  await put('bun.lock', '{}\n')
  await put(
    'turbo.json',
    JSON.stringify({
      tasks: {
        'build-api': { inputs: ['src/**'], outputs: ['api-report.api.md'] },
        build: { dependsOn: ['build-api'], outputs: ['dist/**'] },
      },
    }),
  )
  await put(
    'packages/a/package.json',
    '{"name":"a","scripts":{"build":"tsc","build-api":"api-extractor run"}}\n',
  )
  await put('packages/a/src/index.ts', 'export {}\n')
  await put('packages/a/api-report.api.md', '# api\n')
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root, env })
  git('init', '-q')
  git('add', '.')
  const m = Bun.spawnSync([process.execPath, '--no-install', BIN, '--native', '--no-install'], {
    cwd: root,
    env,
    stdin: 'ignore',
    stderr: 'pipe',
  })
  expect([m.exitCode, m.stderr.toString()]).toEqual([0, ''])
  const vzn = path.join(root, 'node_modules', '@vzn')
  await mkdir(vzn, { recursive: true })
  await symlink(
    path.dirname(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir))),
    path.join(vzn, 'vx'),
    'dir',
  )
  // Only the graph is under test: no plugin the mapper declared.
  await put('.vx/workspace.ts', 'export default { plugins: [] }\n')
  const config = await readFile(path.join(root, 'packages/a/vx.config.ts'), 'utf8')
  expect(config).toContain("'!api-report.api.md'")
  expect(config).not.toContain('reads the committed')
  const lock = Bun.spawnSync([process.execPath, CORE, 'lock'], { cwd: root, env, stderr: 'pipe' })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
})
