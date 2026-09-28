// A test for the example `schedule` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-schedule-'))
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

/** A `vx.workspace.mjs` declaring `call`, e.g. `prioritize()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'schedule.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { prioritize } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('the named task starts first on one worker, whichever it is', async () => {
  for (const name of ['a', 'b']) {
    await pkg(name, `export default { tasks: { build: { exec: { command: 'true' } } } }`)
  }
  const first = async (id: string): Promise<string | undefined> => {
    await workspace(`prioritize([${JSON.stringify(id)}])`)
    const order: string[] = []
    await run({
      cwd: root,
      tasks: ['build'],
      log: log(order),
      handleSignals: false,
      concurrency: 1,
    })
    return order[0]
  }
  expect(await first('b#build')).toBe('start b#build')
  expect(await first('a#build')).toBe('start a#build')
}, 20_000)
