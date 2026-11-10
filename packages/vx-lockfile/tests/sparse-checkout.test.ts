// A sparse checkout leaves a project's manifest out of the worktree. The
// lockfile still links its dependants to it: the edge stands, so a run of
// a dependant is refused for the excluded project rather than run, or hit,
// without it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { commitAll } from './helpers/affected.js'

const CORE_BIN = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n"

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) {
    await rm(d, { recursive: true, force: true })
    await rm(`${d}-cache`, { recursive: true, force: true })
  }
})

function run(root: string, cmd: string[]): { code: number; err: string } {
  // The sandbox mounts the user's install cache read-only.
  const env = {
    ...process.env,
    NO_COLOR: '1',
    BUN_INSTALL_CACHE_DIR: path.join(root, '..', `${path.basename(root)}-cache`),
  }
  const r = Bun.spawnSync({ cmd, cwd: root, env })
  return { code: r.exitCode, err: new TextDecoder().decode(r.stderr).trim() }
}

async function sparseWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-lockfile-sparse-'))
  made.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  const deps: Record<string, Record<string, string>> = {
    app: { lib: 'workspace:*' },
    lib: {},
    other: {},
  }
  for (const [name, dependencies] of Object.entries(deps)) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies }),
    )
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
  }
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['bun()'], `import { bun } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
  for (const cmd of [
    [process.execPath, 'install', '--silent'],
    [process.execPath, CORE_BIN, 'lock'],
  ]) {
    const r = run(root, cmd)
    if (r.code !== 0) throw new Error(`${cmd[1]}: ${r.err}`)
  }
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  commitAll(root)
  const sparse = Bun.spawnSync({
    cmd: ['git', 'sparse-checkout', 'set', '--no-cone', '/*', '!/packages/lib/'],
    cwd: root,
  })
  if (sparse.exitCode !== 0) throw new Error(new TextDecoder().decode(sparse.stderr))
  return root
}

it('a dependant of a project the sparse checkout left out is refused', async () => {
  const root = await sparseWorkspace()
  expect(run(root, [process.execPath, CORE_BIN, 'run', 'build', '--filter', 'app'])).toEqual({
    code: 1,
    err: '✗ vx run  packages/lib is outside this sparse checkout, but this run needs its vx.config.mjs — run `git sparse-checkout add packages/lib`',
  })
}, 60_000)

it('a project that does not depend on it runs', async () => {
  const root = await sparseWorkspace()
  expect(run(root, [process.execPath, CORE_BIN, 'run', 'build', '--filter', 'other']).code).toBe(0)
}, 60_000)
