// An error a tool ends on is often text vx did not write — a config's own
// throw, a plugin's, a crash — and it went to the agent (often a remote
// model) as it was, a secret in it whole (L-11).
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleMessage } from '../src/server.js'

const SECRET = 'supersecretvalue123'
const THROW = `throw new Error('reply token=' + process.env.API_TOKEN + ' id=plainrequest42')`
const SAID = 'reply token=*** id=plainrequest42'
let root: string
let saved: string | undefined

beforeAll(async () => {
  saved = process.env['API_TOKEN']
  process.env['API_TOKEN'] = SECRET
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-mask-')))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  if (saved === undefined) delete process.env['API_TOKEN']
  else process.env['API_TOKEN'] = saved
  await rm(root, { recursive: true, force: true })
})

async function project(name: string, config: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

const call = (name: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })

it("a config's own throw reaches the agent masked", async () => {
  await project('app', `${THROW}\n`)
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache') }
  expect(await handleMessage(call('listTasks'), ctx)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32603, message: SAID },
  })
})

it("a config refusal quoting the config's own string reaches the agent masked", async () => {
  await project('app', "export default { tasks: { t: 'deploy ' + process.env.API_TOKEN } }\n")
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache') }
  expect(await handleMessage(call('listTasks'), ctx)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: `${path.join(root, 'packages', 'app', 'vx.config.mjs')}: tasks.t must be an object — a command is { exec: { command: "deploy ***" } }`,
        },
      ],
      isError: true,
    },
  })
})

it("a tool's crash reaches the agent masked", async () => {
  const crashing = {
    workspaceRoot: root,
    get cacheDir(): string {
      throw new Error(`reply token=${SECRET} id=plainrequest42`)
    },
  }
  expect(await handleMessage(call('getCacheStats'), crashing)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32603, message: SAID },
  })
})
