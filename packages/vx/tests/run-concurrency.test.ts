// The façade's own boundary for its numbers. The CLI and the workspace
// config refuse a `concurrency` that is not a positive integer, a bad
// `retries` and a bad `timeout`; run() took any, and with a concurrency of
// 0, a negative or NaN no worker slot ever opened and the run waited for
// good (C-61).

import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { planRun, run, type Logger, type RunOptions } from '../src/orchestrator/index.js'

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

it('refuses a run that names no task', async () => {
  for (const tasks of [[], ['']]) {
    const said = await run({ cwd: root, tasks, log: silent, handleSignals: false }).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(said).toBe('RunOptions.tasks names no task: give at least one task name')
  }
})

// C-86: the words and shapes the CLI parses. A `continueMode` typo ran as
// `deps-ok`, losing fail-fast without a word; a string
// `excludeDependencies` dropped nothing; a `projects` string and a
// `signal` that is no AbortSignal died a TypeError inside the run.
it('refuses a word or a shape the CLI would not pass, at run() and planRun()', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { continueMode: 'sometimes' },
      `continueMode is "sometimes": it must be one of 'never', 'deps-ok', 'always'`,
    ],
    [
      { outputLogs: 'loud' },
      `outputLogs is "loud": it must be one of 'full', 'errors-only', 'none', 'hash-only'`,
    ],
    [{ download: 'some' }, `download is "some": it must be one of 'all', 'toplevel', 'none'`],
    [{ flow: 'wide' }, `flow is "wide": it must be one of 'focused', 'broad'`],
    [
      { excludeDependencies: 'some' },
      `excludeDependencies is "some": it must be 'all' or an array of task names`,
    ],
    [
      { excludeDependencies: [1] },
      `excludeDependencies is an array: it must be 'all' or an array of task names`,
    ],
    [{ tasks: 'app#t' }, `tasks is "app#t": it must be an array of task names`],
    [{ projects: 'app' }, `projects is "app": it must be an array of project names`],
    [{ forwardArgs: '--x' }, `forwardArgs is "--x": it must be an array of strings`],
    [{ signal: {} }, `signal is an object: it must be an AbortSignal`],
  ]
  for (const [opts, said] of cases) {
    const options = {
      cwd: root,
      tasks: ['app#t'],
      log: silent,
      handleSignals: false,
      ...opts,
    } as RunOptions
    for (const call of [run, planRun]) {
      const got = await call(options).then(
        () => 'ran',
        (e: Error) => e.message,
      )
      expect([call.name, got]).toEqual([call.name, `RunOptions.${said}`])
    }
  }
  // Each word the CLI passes is taken.
  for (const opts of [
    { continueMode: 'never' },
    { excludeDependencies: 'all' },
    { excludeDependencies: ['t'] },
    { signal: new AbortController().signal },
    { projects: ['app'], forwardArgs: ['--x'] },
  ] as const) {
    expect(await runWith(opts as never)).toBe('ok true')
  }
}, 20_000)
