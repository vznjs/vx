// `vx show` printed a field the config sets to an empty list as a bare
// label (`outputs.files` and nothing after it), which reads as a cut-off
// line. An empty list is a value: it says `none`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

// `vx lock`, then `vx show`: show reads the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('vx show prints an empty list as none', async () => {
  const ws = (root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-empty-')))
  await writeFile(
    path.join(ws, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource())
  const dir = path.join(ws, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `
export default {
  tasks: {
    stamp: {
      exec: { command: 'true' },
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: [] } },
    },
  },
}
`,
  )
  const out = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'show', 'a#stamp'],
    cwd: ws,
    env: { ...process.env },
    stdout: 'pipe',
  }).stdout.toString()
  expect(out).toContain('  outputs.files  none\n')
})
