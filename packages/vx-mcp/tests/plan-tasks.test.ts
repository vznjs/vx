// planTasks is `vx run <tasks> --dry=json` through MCP: the CLI's plan,
// and nothing run. Held to the CLI's own output, so the two cannot drift.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
let marker: string
const ctx = () => ({
  cacheDir: path.join(root, '.vx', 'cache'),
  workspaceRoot: root,
  vx: [process.execPath, CORE_BIN],
})

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-plan-'))
  const pkg = path.join(root, 'packages', 'a')
  marker = path.join(pkg, 'ran')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'touch ran' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } } } }\n`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("answers the CLI's --dry=json plan and runs nothing", async () => {
  const got = await handleToolCall('planTasks', { tasks: ['build'], all: true }, ctx())
  const cli = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, 'run', 'build', '--all', '--dry=json'],
    cwd: root,
  })
  expect(got).toEqual({ exitCode: 0, plan: JSON.parse(cli.stdout.toString()) })
  expect((got['plan'] as { tasks: Array<{ id: string; cacheStatus: string }> }).tasks).toEqual([
    expect.objectContaining({ id: 'a#build', cacheStatus: 'miss' }),
  ])
  expect(existsSync(path.join(root, 'packages', 'a'))).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, 30_000)

it('a task no project declares is a refusal: no plan, the CLI message', async () => {
  const got = await handleToolCall('planTasks', { tasks: ['nope'], all: true }, ctx())
  expect(got['plan']).toBeUndefined()
  expect(got['exitCode']).toBe(1)
  expect(got['error']).toContain('nope')
}, 30_000)
