// planInit is `vx init --dry --format json` through MCP: the plan as the
// CLI prints it, and nothing written.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
const ctx = () => ({
  cacheDir: path.join(root, '.vx', 'cache'),
  workspaceRoot: root,
  vx: [process.execPath, CORE_BIN],
})

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-init-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('answers what the CLI prints, and writes nothing', async () => {
  const cli = JSON.parse(
    Bun.spawnSync({
      cmd: [process.execPath, CORE_BIN, 'init', '--dry', '--format', 'json'],
      cwd: root,
    }).stdout.toString(),
  )
  const plan = await handleToolCall('planInit', {}, ctx())
  expect(plan).toEqual({ exitCode: 0, init: cli })
  expect((cli as { files: { path: string }[] }).files.map((f) => f.path)).toEqual([
    'packages/a/vx.config.ts',
    'vx.workspace.ts',
  ])
  expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(false)
})

it('a mode outside Turbo or Nx is the CLI refusal, code and all', async () => {
  const r = (await handleToolCall('planInit', { mode: 'keep' }, ctx())) as Record<string, unknown>
  expect([r['exitCode'], r['code']]).toEqual([1, 'VX_E_REFUSED'])
  await expect(handleToolCall('planInit', { mode: '--force' }, ctx())).rejects.toThrow(
    'planInit: mode must be native or keep',
  )
})
