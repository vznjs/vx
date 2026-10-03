// `vx init` leaves out a root script that shares a member's task name, and
// said of a root left with none that "its scripts run the workspace": a
// bun root whose one script is `eslint .` runs nothing of the workspace.
// The note names the reason that held.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function rootNote(rootScripts: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-root-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      scripts: rootScripts,
    }),
  )
  await writeFile(path.join(root, 'bun.lock'), '')
  const dir = path.join(root, 'packages', 'web')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'web', scripts: { lint: 'eslint src', build: 'vite build' } }),
  )
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'init'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode).toBe(0)
  return (r.stdout.toString() + r.stderr.toString())
    .split('\n')
    .filter((l) => l.startsWith('root (the workspace root)'))
}

it("a root whose scripts share a member's task name says so, not that they run the workspace", async () => {
  expect(await rootNote({ lint: 'eslint .' })).toEqual([
    "root (the workspace root) not mapped: its scripts share a member's task name (lint); declare its own tasks in its vx.config by hand",
  ])
})

it('a root whose scripts run the members keeps its line (control)', async () => {
  expect(await rootNote({ build: 'bun run --filter "*" build' })).toEqual([
    'root (the workspace root) not mapped: its scripts run the workspace; declare its own tasks in its vx.config by hand',
  ])
})

it('a root with both says both', async () => {
  expect(await rootNote({ lint: 'eslint .', all: 'bun run --filter "*" build' })).toEqual([
    "root (the workspace root) not mapped: its scripts run the workspace or share a member's task name (lint); declare its own tasks in its vx.config by hand",
  ])
})
