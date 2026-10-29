// A test for the example `executor` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'
import { shellExecutor } from './executor.ts'

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
  // Core reads no package.json: the config names the project.
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
  )
  return dir
}

/**
 * A `.vx/workspace.mjs` declaring `call`, e.g. `shellExecutor()`, from the plugin file
 * beside this test, then `vx lock`: a run reads project configs only from the lock.
 */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'executor.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { shellExecutor } from ${from}\nexport default { plugins: [${call}] }\n`,
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

it('runs the command and says where; stops it on exec.timeout', async () => {
  const dir = await pkg(
    'a',
    `export default { tasks: {
      hello: { exec: { command: 'echo hi > out.txt' } },
      slow: { exec: { command: 'exec sleep 30', timeout: '300ms' } },
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

it('puts the args after -- on the command as the local executor does', async () => {
  await pkg(
    'a',
    `export default { tasks: { say: { exec: { command: "printf '<%s>' # each arg" } } } }`,
  )
  await workspace('shellExecutor()')
  const out: string[] = []
  const r = await run({
    cwd: root,
    tasks: ['say'],
    forwardArgs: ["it's", 'a b'],
    log: { ...log(), taskStdout: (_n, chunk) => void out.push(chunk) },
    handleSignals: false,
  })
  expect([r.outcomes.map((o) => o.status), out.join('')]).toEqual([['success'], "<it's><a b>"])
}, 20_000)

// An abort fires no listener added after it: a request stopped before
// `execute` ran its command anyway, in a group nothing would stop.
it('starts nothing for a request already aborted', async () => {
  const executor = (await shellExecutor().executor!({} as never))!
  const stop = new AbortController()
  stop.abort('SIGTERM')
  const r = await executor.execute({
    command: 'sleep 0.3; echo ran > ran.txt',
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '' },
    forwardArgs: [],
    onStdout() {},
    onStderr() {},
    signal: stop.signal,
  } as never)
  await Bun.sleep(600)
  expect([r.exitCode, await Bun.file(path.join(root, 'ran.txt')).exists()]).toEqual([143, false])
})

// Core abandons an executor 2 s after its abort: a group that ignored
// SIGTERM ran on, unreached, after the run had ended.
it('kills a group that ignores SIGTERM after a grace', async () => {
  const executor = (await shellExecutor().executor!({} as never))!
  const stop = new AbortController()
  const started = Date.now()
  setTimeout(() => stop.abort('SIGTERM'), 200)
  const r = await executor.execute({
    command: "trap '' TERM; sleep 30",
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '' },
    forwardArgs: [],
    onStdout() {},
    onStderr() {},
    signal: stop.signal,
  } as never)
  expect([r.exitCode, Date.now() - started < 10_000]).toEqual([137, true])
}, 40_000)

// A pipe ends only when every writer closes it: a process the command
// left running (`server &`) held the task open until it exited.
it('ends when the shell exits, though a process it left holds the pipes', async () => {
  const executor = (await shellExecutor().executor!({} as never))!
  const started = Date.now()
  const r = await executor.execute({
    command: 'sleep 5 & echo up',
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '' },
    forwardArgs: [],
    onStdout() {},
    onStderr() {},
  } as never)
  expect([r.exitCode, r.stdout, Date.now() - started < 3_000]).toEqual([0, 'up\n', true])
}, 20_000)
