// `vx mcp`'s tools are a 1.0 contract surface (packages/vx/docs/design/
// versioning-1.0.md): an agent is told each tool's input schema and reads
// its answer by key. `tests/contract/tools.json` records, per tool, the
// input schema and every key path of its answer (`a.b[]` for an array's
// items), from a real workspace with two runs. A renamed or dropped key,
// or a changed schema, is a reviewed diff here. Types are not recorded:
// the doctor's facts are null on one host and numbers on another
// (`memory.cgroupLimitBytes`, `workers.cpuQuota`); tools.test.ts holds the
// cache tools' values.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-tools.test.ts

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { Cache } from '@vzn/vx'
import { handleToolCall, listTools } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const RECORD = path.join(import.meta.dir, 'contract', 'tools.json')

/** An argument per tool that reaches its full answer. */
const ARGS: Record<string, unknown> = {
  listTasks: {},
  getCacheStats: {},
  getRunHistory: {},
  explainCacheKey: { taskId: 'a#build' },
  whyDidThisRerun: { taskId: 'a#build' },
  getWorkspaceInfo: {},
}

/** Every key path in `v`. */
function keys(v: unknown, at = '', out = new Set<string>()): Set<string> {
  if (at !== '') out.add(at)
  if (Array.isArray(v)) for (const item of v) keys(item, `${at}[]`, out)
  else if (v !== null && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) keys(child, at === '' ? k : `${at}.${k}`, out)
  }
  return out
}

let root: string
const run = (): void => {
  const r = Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, 'run', 'build', '--all'], cwd: root })
  expect(r.exitCode).toBe(0)
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-contract-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  // Two runs with an input changed between, so whyDidThisRerun has a
  // previous key to compare with.
  run()
  await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'y')
  run()
  // A task lighter than vx records no peak, and history then omits
  // maxPeakRssBytes: one run with a peak makes the key reachable anywhere.
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  cache.recordRuns([
    {
      hash: 'h',
      project: 'a',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 10,
      forwardArgs: [],
      startedAt: Date.now() - 100,
      endedAt: Date.now() - 90,
      runId: 'seeded',
      cpuMs: 20,
      peakRssBytes: 1 << 30,
      wallclockStartNs: 0n,
      wallclockEndNs: 10_000_000n,
      cacheHit: false,
    },
  ])
  cache.close()
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('each tool agrees with tests/contract/tools.json', async () => {
  const ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
  const live: Record<string, unknown> = {}
  for (const tool of listTools()) {
    expect(Object.keys(ARGS)).toContain(tool.name)
    const answer = await handleToolCall(tool.name, ARGS[tool.name], ctx)
    live[tool.name] = {
      inputSchema: tool.inputSchema,
      answer: [...keys(answer)].sort(),
    }
  }
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    await writeFile(RECORD, text)
  }
  // On a failure, the diff below IS the change an agent sees: regenerate
  // the record (header) only if it is meant to ship.
  expect(text).toBe(await readFile(RECORD, 'utf8'))
})
