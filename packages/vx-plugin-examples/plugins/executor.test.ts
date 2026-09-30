// A test for the example `executor` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-executor-'))
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

/** A `vx.workspace.mjs` declaring `call`, e.g. `shellExecutor()`, from the plugin file beside this test. */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'executor.ts'))
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { shellExecutor } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('runs the command and says where; stops it on exec.timeout', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: {
      hello: { exec: { command: 'echo hi > out.txt' } },
      slow: { exec: { command: 'exec sleep 30', timeout: 300 } },
    } }`,
  )
  await workspace('shellExecutor()')
  const ok = await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  expect(ok.outcomes.map((o) => [o.node.id, o.status, o.where])).toEqual([
    ['a#hello', 'success', 'shell'],
  ])
  expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('hi\n')
  const started = Date.now()
  const slow = await run({ cwd: root, tasks: ['slow'], log: log(), handleSignals: false })
  expect(slow.outcomes.map((o) => [o.node.id, o.status, o.timedOut === true])).toEqual([
    ['a#slow', 'failed', true],
  ])
  expect(Date.now() - started).toBeLessThan(10_000)
}, 20_000)

it("runs the command through this machine's sh, not a project's node_modules/.bin sh", async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: { hello: { exec: { command: 'echo real' } } } }`,
  )
  await mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', '.bin', 'sh'), '#!/bin/sh\necho planted\n', {
    mode: 0o755,
  })
  await workspace('shellExecutor()')
  const out: string[] = []
  const r = await run({
    cwd: root,
    tasks: ['hello'],
    log: { ...log(), taskStdout: (_n, chunk) => void out.push(chunk) },
    handleSignals: false,
  })
  expect([r.outcomes.map((o) => o.status), out.join('')]).toEqual([['success'], 'real\n'])
}, 20_000)
