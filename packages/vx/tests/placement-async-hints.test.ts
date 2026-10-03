// `demand` and `accepts` are synchronous hints. An `async demand` that
// rejected did so where no one listened: an unhandled rejection, a stack
// naming vx's own frames, the run killed with exit 1. An `async accepts`
// answered a Promise, truthy, so the executor took every task, and its
// rejection went unheard too (the shape of H-16's async `admit`).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-async-hints-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'echo build' } } } }\n",
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ok = `async () => ({ exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] })`

async function runWith(executor: string): Promise<{ ok: boolean; status: string[] }> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([pluginSource('org/ex', `{ executor() { return ${executor} } }`)]),
  )
  const status: string[] = []
  const log = {
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status: (m: string) => status.push(m),
  } as unknown as Logger
  const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  return { ok: summary.ok, status }
}

it('an async demand that rejects is named once and the run goes on', async () => {
  const got = await runWith(
    `{ name: 'ex', async demand() { throw new Error('demand-boom') }, execute: ${ok} }`,
  )
  await Bun.sleep(0)
  expect({ ok: got.ok, said: got.status.filter((m) => m.includes('demand')) }).toEqual({
    ok: true,
    said: [
      "[vx] plugin 'org/ex' (executor 'ex') failed in demand: demand-boom; not asked again this run",
    ],
  })
})

it('an async accepts is refused by name, not read as a yes', async () => {
  let message = ''
  await runWith(`{ name: 'ex', async accepts() { return false }, execute: ${ok} }`).then(
    () => (message = 'resolved'),
    (err: unknown) => (message = err instanceof Error ? err.message : String(err)),
  )
  expect(message).toBe(
    "plugin 'org/ex' (executor 'ex') failed in accepts for a#build: returned a Promise; accepts is synchronous",
  )
})

// Control: a demand that throws synchronously was already named (item 1022).
it('a demand that throws is named once and the run goes on', async () => {
  const got = await runWith(
    `{ name: 'ex', demand() { throw new Error('demand-boom') }, execute: ${ok} }`,
  )
  expect({ ok: got.ok, said: got.status.filter((m) => m.includes('demand')) }).toEqual({
    ok: true,
    said: [
      "[vx] plugin 'org/ex' (executor 'ex') failed in demand: demand-boom; not asked again this run",
    ],
  })
})
