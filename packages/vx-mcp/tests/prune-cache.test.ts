// pruneCache is `vx cache prune --format json` through MCP: a dry run
// unless the call says otherwise, held to the CLI's own answer.
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
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-prune-'))
  const pkg = path.join(root, 'packages', 'a')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: {
  build: { exec: { command: 'head -c 8192 /dev/urandom > out.bin' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.bin'] } } },
} }
`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  vx('run', 'a#build')
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('looks by default, evicts only when told, as the CLI does', async () => {
  const cli = (...extra: string[]) =>
    JSON.parse(vx('cache', 'prune', '--max-size', '1K', ...extra, '--format', 'json'))
  const look = await handleToolCall('pruneCache', { maxSize: '1K' }, ctx())
  expect(look).toEqual({ exitCode: 0, prune: cli('--dry-run') })
  expect((look as { prune: { dryRun: boolean; evicted: number } }).prune).toMatchObject({
    dryRun: true,
    evicted: 1,
  })
  const evict = await handleToolCall('pruneCache', { maxSize: '1K', dryRun: false }, ctx())
  expect((evict as { prune: { dryRun: boolean; evicted: number } }).prune).toMatchObject({
    dryRun: false,
    evicted: 1,
  })
  expect(cli('--dry-run').evicted).toBe(0)
})

it('a value that reads as a flag is refused before the CLI sees it', async () => {
  await expect(handleToolCall('pruneCache', { olderThan: '--all' }, ctx())).rejects.toThrow(
    'pruneCache: olderThan must be a string like 30d',
  )
})
