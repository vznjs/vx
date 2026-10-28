// A test for the example `cache` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'
import { dirCache } from './cache.ts'

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
  // Core reads no package.json: the config names the project.
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
  )
  return dir
}

/**
 * A `.vx/workspace.mjs` declaring `call`, e.g. `dirCache()`, from the plugin file
 * beside this test, then `vx lock`: a run reads project configs only from the lock.
 */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'cache.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { dirCache } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('a run on an empty local cache restores from the directory', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
      inputs: { files: ['package.json'] }, cache: { outputs: { files: ['dist/**'] } },
    } } }`,
  )
  await workspace(`dirCache(${JSON.stringify(path.join(root, 'remote'))})`)
  const first = await run({ cwd: root, tasks: ['build'], log: log(), handleSignals: false })
  expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
  await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
  await rm(path.join(dir, 'dist'), { recursive: true, force: true })
  const second = await run({ cwd: root, tasks: ['build'], log: log(), handleSignals: false })
  expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
  expect(await Bun.file(path.join(dir, 'dist', 'out.txt')).text()).toBe('built\n')
}, 20_000)

// Read against the process's cwd, a relative directory was another store
// for a run started in a project's directory than for one at the root.
it('reads a relative directory from the workspace root', async () => {
  const layer = await dirCache('remote').cache!({ workspaceRoot: root } as never)
  expect(layer?.endpoint).toBe(path.join(root, 'remote'))
})

// Two writers of one key shared one temporary name (`.<hash>.<pid>`, and
// containers on one volume share pids): one unlinked the other's file
// mid-put, or linked it while the other rewrote it.
it('two puts of one key at once both land, as one entry', async () => {
  const store = path.join(root, 'remote')
  const layer = (await dirCache(store).cache!({ workspaceRoot: root } as never))!
  const bytes = new Blob(['x'.repeat(1 << 20)])
  const puts = await Promise.allSettled([
    layer.put('k', bytes, { durationMs: 1 }),
    layer.put('k', bytes, { durationMs: 1 }),
  ])
  expect(puts.map((p) => p.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(await readdir(store)).toEqual(['k'])
  expect((await (await layer.get('k'))!.body.arrayBuffer()).byteLength).toBe(1 << 20)
})
