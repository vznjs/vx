// A test for the example `cache` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-cache-'))
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

/** A `vx.workspace.mjs` declaring `call`, e.g. `dirCache()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'cache.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { dirCache } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('a run on an empty local cache restores from the directory', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
      cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
    } } }`,
  )
  await workspace(`dirCache(${JSON.stringify(path.join(root, 'remote'))})`)
  const first = await run({ cwd: root, tasks: ['build'], log: log(), handleSignals: false })
  expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
  await rm(path.join(root, '.vx'), { recursive: true, force: true })
  await rm(path.join(dir, 'dist'), { recursive: true, force: true })
  const second = await run({ cwd: root, tasks: ['build'], log: log(), handleSignals: false })
  expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
  expect(await Bun.file(path.join(dir, 'dist', 'out.txt')).text()).toBe('built\n')
}, 20_000)
