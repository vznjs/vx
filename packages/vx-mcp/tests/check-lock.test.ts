// checkLock is `vx lock --check --format json` through MCP, held to the
// CLI's own answer: missing, current, then drifted.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, ...args], cwd: root })

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-lock-'))
  const pkg = path.join(root, 'packages', 'a')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'echo built' } } } }\n`,
  )
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("each state is the CLI's answer, with its exit code", async () => {
  const both = async () => {
    const cli = vx('lock', '--check', '--format', 'json')
    return [
      await handleToolCall('checkLock', {}, ctx()),
      { exitCode: cli.exitCode, lock: JSON.parse(cli.stdout.toString()) },
    ]
  }
  const missing = await both()
  expect(vx('lock').exitCode).toBe(0)
  const current = await both()
  await appendFile(path.join(root, 'packages', 'a', 'vx.config.mjs'), '// edited\n')
  const drifted = await both()
  for (const [got, want] of [missing, current, drifted]) expect(got).toEqual(want)
  expect(
    [missing, current, drifted].map(([got]) => (got as { exitCode: number }).exitCode),
  ).toEqual([1, 0, 1])
})
