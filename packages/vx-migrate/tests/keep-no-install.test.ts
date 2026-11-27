// `--no-install` says it skips `vx lock`, and native config did; `--keep`
// ran `vx lock` all the same once the plugins resolved, and its failure
// (a turbo.json Turbo itself refuses) failed the migration it was told
// to leave unlocked.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('--keep --no-install writes the workspace file and leaves vx lock to the user', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-keep-no-install-'))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'echo b' } }),
  )
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
  // Installed as far as the report checks; a `vx lock` run would fail on them.
  for (const p of ['vx', 'vx-migrate', 'vx-history']) {
    await mkdir(path.join(root, 'node_modules', '@vzn', p), { recursive: true })
    await writeFile(path.join(root, 'node_modules', '@vzn', p, 'package.json'), '{}')
  }
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, '--keep', '--no-install'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const out = p.stdout.toString()
  expect([
    p.exitCode,
    await Bun.file(path.join(root, '.vx', 'workspace.ts')).exists(),
    await Bun.file(path.join(root, '.vx', 'projects.lock')).exists(),
    out.includes('vx lock, then vx run build --all'),
  ]).toEqual([0, true, false, true])
})
