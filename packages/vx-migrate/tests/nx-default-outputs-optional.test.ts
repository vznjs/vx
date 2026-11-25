// An Nx `build` that declares no outputs caches Nx's defaults: `dist/{root}`,
// `{root}/dist`, `{root}/build` and `{root}/public`, each kept only if it
// exists. Mapped as literal paths, which vx requires, a build writing only
// `{root}/dist` failed with "outputs matched no files". Each maps as the
// tree under it, which may match nothing beside one that matched.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

const CORE = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-default-outputs-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mapped(migration: boolean) {
  const dir = path.join(root, 'packages', 'store')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'store' }))
  const build = { command: 'tsdown', cache: true, inputs: ['{projectRoot}/**/*'] }
  const nodes = { store: { data: { root: 'packages/store', targets: { build } } } }
  const graph = { nodes, dependencies: { store: [] } } as NxGraph
  const meta = { name: 'store', dir, packageJson: { name: 'store' } as never, configPath: null }
  return mapNxWorkspace(root, [meta], graph, { cacheable: new Set(), migration })
}

// nx() and the written vx.config.ts (a migration) map them alike.
it('maps each default output as a tree that may match nothing', async () => {
  for (const migration of [false, true]) {
    const outputs = (await mapped(migration)).projects[0]!.tasks[0]!.task!.outputs
    expect(outputs).toEqual({ files: ['dist/**'], workspaceFiles: ['dist/packages/store/**'] })
  }
})

it('a build that writes only its own dist/ passes and caches', async () => {
  const m = await mapped(false)
  const outputs = m.projects[0]!.tasks[0]!.task!.outputs
  const dir = path.join(root, 'packages', 'store')
  await writeFile(path.join(dir, 'src', 'a.ts'), 'export {}\n')
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, '.vx', 'workspace.mjs'), 'export default {}\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: { build: ${JSON.stringify({
      exec: { command: 'mkdir -p dist && echo x > dist/a.js' },
      inputs: { files: ['src/**'] },
      outputs,
      cache: true,
    })} } }\n`,
  )
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  const env = { ...process.env, HOME: root }
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
  const lock = Bun.spawnSync([process.execPath, CORE, 'lock'], { cwd: root, env, stderr: 'pipe' })
  expect(lock.exitCode).toBe(0)
  const run = Bun.spawnSync([process.execPath, CORE, 'run', 'packages/store#build'], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const said = `${run.stdout.toString()}${run.stderr.toString()}`
  expect(said).not.toContain('outputs matched no files')
  expect(run.exitCode).toBe(0)
}, 30_000)

it('a migration names no literal output on a target that declares none', async () => {
  expect((await mapped(true)).notes.join('\n')).not.toContain('literal output')
})
