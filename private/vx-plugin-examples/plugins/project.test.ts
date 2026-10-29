// A test for the example `project` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-project-'))
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
 * A `.vx/workspace.mjs` declaring `call`, e.g. `scriptTasks()`, from the plugin file
 * beside this test, then `vx lock`: a run reads project configs only from the lock.
 */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'project.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { scriptTasks } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('a package.json script runs as a task; a declared task wins', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: { build: { exec: { command: 'echo declared > build.txt' } } } }`,
    { hello: 'echo hi > hello.txt', build: 'echo script > build.txt' },
  )
  await workspace('scriptTasks()')
  const r = await run({ cwd: root, tasks: ['hello', 'build'], log: log(), handleSignals: false })
  expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
    'a#build success',
    'a#hello success',
  ])
  expect(await Bun.file(path.join(dir, 'hello.txt')).text()).toBe('hi\n')
  expect(await Bun.file(path.join(dir, 'build.txt')).text()).toBe('declared\n')
}, 20_000)

// A blank script, or one no task can be named after (a `#` comment key),
// was handed to core, which refused the project: every run of it failed.
it('leaves out a blank script and one no task can be named after', async () => {
  const dir = await pkg('a', `export default { tasks: {} }`, {
    '# notes': 'see README',
    test: '',
    hello: 'echo hi > hello.txt',
  })
  await workspace('scriptTasks()')
  const r = await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`)).toEqual(['a#hello success'])
  expect(await Bun.file(path.join(dir, 'hello.txt')).text()).toBe('hi\n')
}, 20_000)
