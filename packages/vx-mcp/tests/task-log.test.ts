// getTaskLog is `vx last --log <task> --format json` through MCP, held to
// the CLI's own answer.
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
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-log-'))
  const pkg = path.join(root, 'packages', 'a')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: {
  build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } },
  bad: { exec: { command: 'echo boom; exit 3' } },
} }
`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  vx('run', 'a#build')
  vx('run', 'a#bad')
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each(['a#build', 'a#bad'])("%s: the CLI's --log answer", async (taskId) => {
  const got = await handleToolCall('getTaskLog', { taskId }, ctx())
  expect(got).toEqual(JSON.parse(vx('last', '--log', taskId, '--format', 'json')))
  expect(got['output']).toBe(taskId === 'a#build' ? 'built\n' : 'boom\n')
})

it('a task no run recorded is refused by name', async () => {
  await expect(handleToolCall('getTaskLog', { taskId: 'a#nope' }, ctx())).rejects.toThrow(
    'getTaskLog: no recorded run of a#nope',
  )
})
