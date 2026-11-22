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
