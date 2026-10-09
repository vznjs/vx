// whyDidThisRerun answered only whether the key moved; `vx why --format
// json` also says what moved and, under a moved upstream, which task's own
// inputs moved. An agent asking through MCP must get the same answer as
// one shelling out, so this row holds the two equal on a real run.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
const vx = (...args: string[]): string => {
  const r = Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, ...args], cwd: root })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString()
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-why-'))
  const pkg = path.join(root, 'packages', 'a')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(path.join(pkg, 'src'), { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(pkg, 'src', 'x.js'), 'x')
  await writeFile(path.join(pkg, 'main.js'), 'm')
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `const cache = (files) => ({ inputs: { files }, outputs: { files: [] } })
export default { tasks: {
  gen: { exec: { command: 'true' }, cache: cache(['src/**']) },
  build: { exec: { command: 'true' }, dependsOn: ['gen'], cache: cache(['main.js']) },
} }
`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  vx('run', 'a#build')
  // Only gen's input moves: build reruns through the edge alone.
  await writeFile(path.join(pkg, 'src', 'x.js'), 'y')
  vx('run', 'a#build')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("whyDidThisRerun carries `vx why --format json`'s diff and roots", async () => {
  const cli = JSON.parse(vx('why', 'a#build', '--format', 'json')) as Record<string, unknown>
  const mcp = await handleToolCall(
    'whyDidThisRerun',
    { taskId: 'a#build' },
    { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root },
  )
  expect(cli['roots']).toEqual([
    { chain: ['a#build', 'a#gen'], entries: expect.any(Array) as unknown },
  ])
  expect({ runId: mcp['runId'], diff: mcp['diff'], roots: mcp['roots'] }).toEqual({
    runId: cli['runId'],
    diff: cli['diff'],
    roots: cli['roots'],
  })
}, 30_000)
