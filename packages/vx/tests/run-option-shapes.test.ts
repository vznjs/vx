// The façade's boundary for the words and shapes the CLI parses (C-86). A
// `continueMode` typo ran as `deps-ok`, losing fail-fast without a word; a
// string `excludeDependencies` dropped nothing; a `projects` string and a
// `signal` that is no AbortSignal died a TypeError inside the run.

import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { planRun, run, type Logger, type RunOptions } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-option-shapes-' })
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const optionsWith = (opts: Record<string, unknown>) =>
  ({ cwd: root, tasks: ['app#t'], log: silent, handleSignals: false, ...opts }) as RunOptions

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
    for (const call of [run, planRun]) {
      const got = await call(optionsWith(opts)).then(
        () => 'ran',
        (e: Error) => e.message,
      )
      expect([call.name, got]).toEqual([call.name, `RunOptions.${said}`])
    }
  }
}, 20_000)

it('takes each word the CLI passes', async () => {
  for (const opts of [
    { continueMode: 'never' },
    { excludeDependencies: 'all' },
    { excludeDependencies: ['t'] },
    { signal: new AbortController().signal },
    { projects: ['app'], forwardArgs: ['--x'] },
  ]) {
    const got = await run(optionsWith(opts)).then(
      (r) => `ok ${r.ok}`,
      (e: Error) => e.message,
    )
    expect(got).toBe('ok true')
  }
}, 20_000)
