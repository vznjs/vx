// `RunOptions.concurrency` is the façade's own boundary. The CLI and the
// workspace config refuse a value that is not a positive integer; run()
// took one, and with 0, a negative or NaN no worker slot ever opened and
// the run waited for good (C-61).

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

const runWith = (concurrency: number) =>
  run({ cwd: root, tasks: ['app#t'], concurrency, log: silent, handleSignals: false }).then(
    (r) => `ok ${r.ok}`,
    (e: Error) => e.message,
  )

it('refuses a concurrency that is not a positive integer, and runs at 1', async () => {
  for (const c of [0, -1, 1.5, Number.NaN]) {
    expect(await runWith(c)).toBe(
      `RunOptions.concurrency is ${String(c)}: it must be a positive integer`,
    )
  }
  expect(await runWith(1)).toBe('ok true')
}, 20_000)
