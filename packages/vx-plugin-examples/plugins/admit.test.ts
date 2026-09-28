// A test for the example `admit` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-admit-'))
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

/** A `vx.workspace.mjs` declaring `call`, e.g. `oneAtATime()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'admit.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { oneAtATime } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('two tasks of the named task never overlap, even with two workers', async () => {
  for (const name of ['a', 'b']) {
    await pkg(name, `export default { tasks: { serve: { exec: { command: 'sleep 0.2' } } } }`)
  }
  await workspace(`oneAtATime('serve')`)
  const order: string[] = []
  await run({ cwd: root, tasks: ['serve'], log: log(order), handleSignals: false, concurrency: 2 })
  // Each start is followed by its own end: no second start in between.
  expect(order).toHaveLength(4)
  expect(order[1]!.replace('end', 'start')).toBe(order[0]!)
  expect(order[3]!.replace('end', 'start')).toBe(order[2]!)
}, 20_000)
