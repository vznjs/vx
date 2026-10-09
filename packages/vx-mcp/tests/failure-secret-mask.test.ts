// A failed task's output reaches an agent four ways: the runTasks summary,
// getFailures, `vx last --format json` and the file under failures/ they
// read. Each holds the secret masked, on the uncached path (a declared
// name) and the cached one (a name-based secret, re-bounded from the
// entry's capture).
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const PLUGIN_ENTRY = path.resolve(import.meta.dir, '../src/index.ts')
const SECRET = 's3cr3t-value-7f2'

let root: string
let ctx: { cacheDir: string; workspaceRoot: string; vx: readonly string[] }

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-fail-mask-'))
  ctx = {
    cacheDir: path.join(root, '.vx', 'cache'),
    workspaceRoot: root,
    vx: [process.execPath, CORE_BIN],
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    `export default { tasks: {
      plain: { exec: { command: 'echo pat=$GH_PAT >&2; exit 3', env: { define: { GH_PAT: '${SECRET}' }, secret: ['GH_PAT'] } } },
      cached: {
        exec: { command: 'echo token=$API_TOKEN; exit 4', env: { define: { API_TOKEN: '${SECRET}' } } },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
      },
    } }\n`,
  )
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { mcp } from ${JSON.stringify(PLUGIN_ENTRY)}\nexport default { plugins: [mcp()] }\n`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("a failed task's output reaches every agent surface masked", async () => {
  const run = await handleToolCall('runTasks', { tasks: ['a#plain', 'a#cached'] }, ctx)
  expect(run['exitCode']).toBe(1)

  const failures = (await handleToolCall('getFailures', {}, ctx)) as {
    tasks: Array<{ taskId: string; output: string }>
  }
  // CONTROL: the line that held the secret is there, so masking, not a
  // missing capture, is what keeps the value out.
  expect(Object.fromEntries(failures.tasks.map((t) => [t.taskId, t.output.trim()]))).toEqual({
    'a#plain': 'pat=***',
    'a#cached': 'token=***',
  })

  const last = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, 'last', '--format', 'json'],
    cwd: root,
  })
  expect(last.exitCode).toBe(0)
  const lastJson = last.stdout.toString()
  expect(lastJson).toContain('pat=***')

  const dir = path.join(ctx.cacheDir, 'failures')
  const files = await Promise.all(
    (await readdir(dir)).map((n) => readFile(path.join(dir, n), 'utf8')),
  )
  expect(files.length).toBe(1)

  const surfaces = {
    runTasks: JSON.stringify(run),
    getFailures: JSON.stringify(failures),
    last: lastJson,
    file: files.join(''),
  }
  const leaked = Object.entries(surfaces)
    .filter(([, text]) => text.includes(SECRET))
    .map(([name]) => name)
  expect(leaked).toEqual([])
})
