// A test for the example `telemetry` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-telemetry-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A package `name` whose `vx.config.mjs` is `config`. */
async function pkg(
  name: string,
  config: string,
  scripts?: Record<string, string>,
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...(scripts ? { scripts } : {}) }),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

/** A `vx.workspace.mjs` declaring `call`, e.g. `jsonlTelemetry()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'telemetry.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { jsonlTelemetry } from ${from}\nexport default { plugins: [${call}] }\n`,
  )
}

function log(order: string[] = []): Logger {
  return {
    status() {},
    taskStart(node) {
      order.push(`start ${node.id}`)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete(node) {
      order.push(`end ${node.id}`)
    },
  }
}

it('appends one line per run', async () => {
  await pkg('a', `export default { tasks: { hello: { exec: { command: 'true' } } } }`)
  const file = path.join(root, 'runs.jsonl')
  await workspace(`jsonlTelemetry(${JSON.stringify(file)})`)
  await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  expect(await Bun.file(file).text()).toBe(
    '{"tasks":1,"failed":0,"cached":0}\n{"tasks":1,"failed":0,"cached":0}\n',
  )
}, 20_000)
