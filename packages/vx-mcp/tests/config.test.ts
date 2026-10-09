// getConfig is `vx show <target> --format json` through MCP, held to the
// CLI's own answer.
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
const vx = (...args: string[]) =>
  Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, ...args], cwd: root }).stdout.toString()

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-config-'))
  const pkg = path.join(root, 'packages', 'a')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: {
  build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
} }
`,
  )
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each(['a', 'a#build', 'build'])("%s: the CLI's show answer", async (target) => {
  const got = await handleToolCall('getConfig', { target }, ctx())
  expect(got).toEqual({ exitCode: 0, config: JSON.parse(vx('show', target, '--format', 'json')) })
})

it('a target that reads as a flag is refused before the CLI sees it', async () => {
  await expect(handleToolCall('getConfig', { target: '--all' }, ctx())).rejects.toThrow(
    'getConfig: target must be a project, project#task, or task name',
  )
})
