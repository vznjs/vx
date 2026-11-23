// `--fail-fast` stops the run at the first failure: the tasks still running
// are killed (they end `aborted`, never cached) and the rest skip. Without
// it a failure skips only its dependants.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import type { RunSummaryRecord } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

// `slow` writes its output only after a wait `boom` cannot outlast; `after`
// depends on nothing failed but dispatches last at concurrency 2.
const workspace = async (wait: string): Promise<string> => {
  const dir = await makeWorkspace({ prefix: 'vx-fail-fast-' })
  await addProject(
    dir,
    'app',
    `export default { tasks: {
      boom: { exec: { command: 'sleep 0.3; exit 3' } },
      slow: {
        inputs: { files: ['vx.config.mjs'] },
        outputs: { files: ['slow.out'] },
        exec: { command: 'sleep ${wait}; echo done > slow.out' },
      },
      after: { dependsOn: ['slow'], exec: { command: 'touch after.ran' } },
    } }`,
  )
  gitInitCommit(dir, 'init')
  return dir
}

const runIn = (dir: string, failFast?: boolean) =>
  run({
    cwd: dir,
    tasks: ['app#boom', 'app#after'],
    concurrency: 2,
    ...(failFast !== undefined ? { failFast } : {}),
    log: silent,
    handleSignals: false,
  })

const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))

it('--fail-fast kills the task still running at the first failure', async () => {
  root = await workspace('20')
  const started = performance.now()
  const result = await runIn(root, true)
  // Well under the 20 s `slow` would take: the run did not wait for it.
  expect(performance.now() - started).toBeLessThan(10_000)
  expect(statusOf(result)).toEqual({
    'app#boom': 'failed',
    'app#slow': 'aborted',
    'app#after': 'skipped',
  })
  expect(result.ok).toBe(false)
  expect(existsSync(join(root, 'packages/app/slow.out'))).toBe(false)
  expect(existsSync(join(root, 'packages/app/after.ran'))).toBe(false)
  // Nothing of the killed task was saved: the next run executes it.
  const again = await runIn(root, false)
  expect(statusOf(again)['app#slow']).toBe('success')
}, 60_000)

it('CONTROL: without --fail-fast the sibling finishes and its dependant runs', async () => {
  root = await workspace('1')
  const result = await runIn(root)
  expect(statusOf(result)).toEqual({
    'app#boom': 'failed',
    'app#slow': 'success',
    'app#after': 'success',
  })
  expect(result.ok).toBe(false)
  expect(existsSync(join(root, 'packages/app/after.ran'))).toBe(true)
}, 60_000)

// `late` exits on its own and leaves a child holding its output pipe, so vx
// is still draining it when `first` fails. `first` waits until `late`'s shell
// is gone (reaped by vx), so the order holds without a timer. The stop reached
// a command that had already exited: its exit is its own, never the stop's
// abort.
for (const [code, said] of [
  [3, 'failed 3'],
  [0, 'success 0'],
] as const) {
  it(`--fail-fast: a task that exited ${code} before the stop reads ${said}, not aborted`, async () => {
    root = await makeWorkspace({ prefix: 'vx-fail-fast-own-' })
    await addProject(
      root,
      'first',
      `export default { tasks: { go: { exec: { command: 'while [ ! -f ../../late.pid ]; do :; done; p=$(cat ../../late.pid); while kill -0 $p 2>/dev/null; do :; done; exit 1' } } } }`,
    )
    await addProject(
      root,
      'late',
      `export default { tasks: { go: { exec: { command: 'echo $$ > ../../late.pid; (sleep 2) & exit ${code}' } } } }`,
    )
    gitInitCommit(root, 'init')
    let summary: RunSummaryRecord | undefined
    const result = await run({
      cwd: root,
      tasks: ['first#go', 'late#go'],
      concurrency: 2,
      failFast: true,
      log: silent,
      handleSignals: false,
      telemetrySinks: [{ onRunSummary: (s) => (summary = s) }],
    })
    const want = { 'first#go': 'failed 1', 'late#go': said }
    expect(
      Object.fromEntries(result.outcomes.map((o) => [o.node.id, `${o.status} ${o.exitCode}`])),
    ).toEqual(want)
    expect(
      Object.fromEntries(summary!.tasks.map((t) => [t.taskId, `${t.status} ${t.exitCode}`])),
    ).toEqual(want)
    expect(summary!.abortedCount).toBe(0)
  }, 60_000)
}
