// A plugin's throw quotes what it was told (a remote's reply, a header it
// sent), and core wraps it in the error `run()` rejects with. The CLI
// masks that at its last line, but an embedder calling `run()` and `vx
// mcp` print the message as they get it, so a secret in it reached them
// whole (L-11).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

const SECRET = 'supersecretvalue123'
const THROW = `throw new Error('reply token=' + process.env.API_TOKEN + ' id=plainrequest42')`
const SAID = 'reply token=*** id=plainrequest42'
let root: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env['API_TOKEN']
  process.env['API_TOKEN'] = SECRET
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-err-mask-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const dir = path.join(root, 'packages', 'app')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: { t: { exec: { command: 'true' } } } }\n`,
  )
})
afterEach(async () => {
  if (saved === undefined) delete process.env['API_TOKEN']
  else process.env['API_TOKEN'] = saved
  await rm(root, { recursive: true, force: true })
})

const silent = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
  runStart() {},
  taskStart() {},
  runStatus() {},
  runEnd() {},
} as unknown as Logger

async function refusal(hooks: string): Promise<string> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([pluginSource('org/p', hooks)]),
  )
  return run({ cwd: root, tasks: ['t'], log: silent }).then(
    () => 'resolved',
    (e: unknown) => (e as Error).message,
  )
}

it("run() rejects with a plugin's setup failure masked", async () => {
  expect(await refusal(`{ setup() { ${THROW} } }`)).toBe(`plugin 'org/p' failed in setup: ${SAID}`)
}, 20_000)

it("run() rejects with a plugin's stage failure masked", async () => {
  expect(await refusal(`{ project() { ${THROW} } }`)).toBe(
    `plugin 'org/p' failed in project: ${SAID}`,
  )
  expect(await refusal(`{ key() { ${THROW} } }`)).toBe(`plugin 'org/p' failed in key: ${SAID}`)
}, 20_000)
