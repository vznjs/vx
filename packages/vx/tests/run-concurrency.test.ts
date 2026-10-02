// The façade's own boundary for its numbers. The CLI and the workspace
// config refuse a `concurrency` that is not a positive integer, a bad
// `retries` and a bad `timeout`; run() took any, and with a concurrency of
// 0, a negative or NaN no worker slot ever opened and the run waited for
// good (C-61).

import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-concurrency-' })
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const runWith = (opts: { concurrency?: number; retries?: number; timeout?: number }) =>
  run({ cwd: root, tasks: ['app#t'], ...opts, log: silent, handleSignals: false }).then(
    (r) => `ok ${r.ok}`,
    (e: Error) => e.message,
  )

it('refuses a concurrency that is not a positive integer, and runs at 1', async () => {
  for (const c of [0, -1, 1.5, Number.NaN]) {
    expect(await runWith({ concurrency: c })).toBe(
      `RunOptions.concurrency is ${String(c)}: it must be a positive integer`,
    )
  }
  expect(await runWith({ concurrency: 1 })).toBe('ok true')
}, 20_000)

// A NaN `retries` retried a failing task without end; a bad `timeout`
// killed every task at once, failed 143.
it('refuses retries and a timeout the CLI refuses, and runs at their edges', async () => {
  for (const r of [-1, 1.5, Number.NaN]) {
    expect(await runWith({ retries: r })).toBe(
      `RunOptions.retries is ${String(r)}: it must be a non-negative integer`,
    )
  }
  for (const t of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
    expect(await runWith({ timeout: t })).toBe(
      `RunOptions.timeout is ${String(t)}: it must be a positive integer of ms, at most 2147483647`,
    )
  }
  expect(await runWith({ retries: 0, timeout: 2 ** 31 - 1 })).toBe('ok true')
}, 20_000)
