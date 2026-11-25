// A member directory the committed .gitignore ignores, with a manifest git
// does not track, is machine-local: the manager installs it, so the
// lockfile lists it, and the lock held it as a project. A fresh clone,
// where it is not, then refused every run (`vx lock --check`). A member
// the lock holds is one every clone has.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { commitAll } from './helpers/affected.js'

const CORE_BIN = path.resolve(import.meta.dir, '../node_modules/.bin/vx')
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) {
    await rm(d, { recursive: true, force: true })
    await rm(`${d}-cache`, { recursive: true, force: true })
  }
})

async function member(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, 'packages', name), { recursive: true })
  await writeFile(
    path.join(root, 'packages', name, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  )
}

/** `bun install`, then `vx lock`; the two locks' text. */
async function locked(root: string): Promise<string> {
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
  const read = (f: string) => readFile(path.join(root, '.vx', f), 'utf8')
  return `${await read('projects.lock')}\n${await read('dependencies.lock')}`
}

it('a gitignored, untracked member is no project; a force-added one is', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-lockfile-ignored-member-'))
  made.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, '.gitignore'), 'node_modules\npackages/local\npackages/kept\n')
  await member(root, 'a')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['bun()'], `import { bun } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  commitAll(root)
  const clone = await locked(root)
  await member(root, 'local')
  expect(await locked(root)).toBe(clone)
  // Tracked despite the rule: every clone has it.
  await member(root, 'kept')
  Bun.spawnSync({ cmd: ['git', 'add', '-f', 'packages/kept/package.json'], cwd: root })
  expect(await locked(root)).toContain('packages/kept')
}, 30_000)
