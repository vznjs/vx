// A deleted project takes its edges with it, so `--affected` reads them
// from the base commit's `.vx/dependencies.lock.json`, the edges this
// plugin's `discover` gave `vx lock`: only those projects are selected.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll } from './helpers/affected.js'

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

async function workspace(deps: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-lockfile-deleted-'))
  made.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
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
  install(root)
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  commitAll(root)
  return root
}

/** `bun install`, then `vx lock`: the lock follows the projects. */
function install(root: string): void {
  for (const cmd of [
    [process.execPath, 'install', '--silent'],
    [process.execPath, CORE_BIN, 'lock'],
  ]) {
    // The sandbox mounts the user's install cache read-only.
    const env = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: path.join(root, '..', `${path.basename(root)}-cache`),
    }
    const r = Bun.spawnSync({ cmd, cwd: root, env })
    if (r.exitCode !== 0) throw new Error(`${cmd[1]}: ${new TextDecoder().decode(r.stderr)}`)
  }
}

it('a deleted project selects only the projects the lockfile linked to it', async () => {
  const root = await workspace({ app: { lib: 'workspace:*' }, lib: {}, other: {} })
  await rm(path.join(root, 'packages/lib'), { recursive: true })
  await writeFile(
    path.join(root, 'packages/app/package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0' }),
  )
  install(root)
  expect(affectedIds(root, 'build')).toEqual(['app#build'])
})

it('a deleted project nothing linked to selects none', async () => {
  const root = await workspace({ app: {}, lib: {}, other: {} })
  await rm(path.join(root, 'packages/lib'), { recursive: true })
  install(root)
  expect(affectedIds(root, 'build')).toEqual([])
})
