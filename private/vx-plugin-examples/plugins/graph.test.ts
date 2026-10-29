// A test for the example `graph` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { planRun, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-graph-'))
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
  // Core reads no package.json: the config names the project.
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
  )
  return dir
}

/**
 * A `.vx/workspace.mjs` declaring `call`, e.g. `chain()`, from the plugin file
 * beside this test, then `vx lock`: a run reads project configs only from the lock.
 */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'graph.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { chain } from ${from}\nexport default { plugins: [${call}] }\n`,
  )
  const vx = path.join(path.dirname(new URL(import.meta.resolve('@vzn/vx')).pathname), 'bin.ts')
  const lock = Bun.spawnSync({ cmd: [process.execPath, vx, 'lock'], cwd: root })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
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

it('each named task waits on the one before it in id order', async () => {
  for (const name of ['a', 'b', 'c']) {
    await pkg(name, `export default { tasks: { build: { exec: { command: 'true' } } } }`)
  }
  await workspace(`chain('build')`)
  const plan = await planRun({ cwd: root, tasks: ['build'], log: log() })
  expect(plan.tasks.map((t) => `${t.node.id} <- ${t.deps.join(',')}`).sort()).toEqual([
    'a#build <- ',
    'b#build <- a#build',
    'c#build <- b#build',
  ])
}, 20_000)

// Id order alone put a#build before b#build even when a#build already
// waits on b#build: the added edge closed a cycle and the run was refused.
it('chains in dependency order, never closing a cycle', async () => {
  await pkg(
    'a',
    `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['b#build'] } } }`,
  )
  for (const name of ['b', 'c']) {
    await pkg(name, `export default { tasks: { build: { exec: { command: 'true' } } } }`)
  }
  await workspace(`chain('build')`)
  const plan = await planRun({ cwd: root, tasks: ['build'], log: log() })
  expect(plan.tasks.map((t) => `${t.node.id} <- ${t.deps.join(',')}`).sort()).toEqual([
    'a#build <- b#build',
    'b#build <- ',
    'c#build <- a#build',
  ])
}, 20_000)
