// A test for the example `key` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { planRun, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-key-'))
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

/** A `vx.workspace.mjs` declaring `call`, e.g. `envKey()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'key.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { envKey } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it("the variable's value moves the key; the same value keeps it", async () => {
  await pkg(
    'a',
    `export default { tasks: { build: {
      exec: { command: 'true' },
      cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
    } } }`,
  )
  await workspace(`envKey(['EXAMPLE_FLAG'])`)
  const hash = async (value: string): Promise<string | undefined> => {
    process.env['EXAMPLE_FLAG'] = value
    try {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: log() })
      return plan.tasks[0]!.hash
    } finally {
      delete process.env['EXAMPLE_FLAG']
    }
  }
  const one = await hash('1')
  expect(one).toBeDefined()
  expect(await hash('1')).toBe(one)
  expect(await hash('2')).not.toBe(one)
}, 20_000)
