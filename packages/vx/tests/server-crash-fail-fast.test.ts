// A server that dies while the graph runs is a failure to what has not
// yet started: its dependants skip, and `--continue=never` stops dispatch,
// as below a failed task. The run went on building against a dead server
// and said so only at its end.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

// `a` asks the server to exit 7, then waits until vx has reaped it
// (`kill -0` holds for a zombie), so its death is known before `b`
// would dispatch.
const workspace = async (): Promise<string> => {
  const dir = await makeWorkspace({ prefix: 'vx-crash-ff-' })
  await addProject(
    dir,
    'app',
    `export default { tasks: {
      srv: { exec: {
        command: 'echo $$ > srv.pid; echo ready; while [ ! -f stop ]; do sleep 0.02; done; exit 7',
        persistent: { readyWhen: 'ready' },
      } },
      a: { dependsOn: ['srv'], exec: {
        command: 'touch stop; while kill -0 $(cat srv.pid) 2>/dev/null; do sleep 0.02; done',
      } },
      b: { dependsOn: ['a'], exec: { command: 'touch b.ran' } },
      c: { dependsOn: ['srv', 'a'], exec: { command: 'touch c.ran' } },
    } }`,
  )
  return dir
}

const runIn = (dir: string, continueMode: 'never' | 'deps-ok') =>
  run({ cwd: dir, tasks: ['app#b', 'app#c'], continueMode, log: silent, handleSignals: false })

const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))

it('a server that dies mid-run stops a --continue=never run from dispatching', async () => {
  root = await workspace()
  const result = await runIn(root, 'never')
  expect(statusOf(result)).toEqual({
    'app#srv': 'failed',
    'app#a': 'success',
    'app#b': 'skipped',
    'app#c': 'skipped',
  })
  expect(existsSync(join(root, 'packages/app/b.ran'))).toBe(false)
  expect(result.ok).toBe(false)
}, 20_000)

// Under the default mode a dependant of the dead server not yet started
// is skipped, named for it, as below a failed task; one that does not
// depend on it still runs.
it('a deps-ok run skips what depends on a dead server, and only that', async () => {
  root = await workspace()
  const result = await runIn(root, 'deps-ok')
  expect(statusOf(result)).toEqual({
    'app#srv': 'failed',
    'app#a': 'success',
    'app#b': 'success',
    'app#c': 'skipped',
  })
  expect(result.outcomes.find((o) => o.node.id === 'app#c')?.blockedBy).toBe('app#srv')
  expect(existsSync(join(root, 'packages/app/c.ran'))).toBe(false)
}, 20_000)
