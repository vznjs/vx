// A group is a name for its deps: a task that reaches a server through
// one depends on it. The group finished the moment the server was ready,
// so when the server died mid-run, a task behind the group ran against
// it while a direct dependant skipped.

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

it('a task behind a group skips when the server the group stands for dies', async () => {
  root = await makeWorkspace({ prefix: 'vx-crash-group-' })
  // `a` asks the server to exit 7, then waits until vx has reaped it.
  await addProject(
    root,
    'app',
    `export default { tasks: {
      srv: { exec: {
        command: 'echo $$ > srv.pid; echo ready; while [ ! -f stop ]; do sleep 0.02; done; exit 7',
        persistent: { readyWhen: 'ready' },
      } },
      up: { dependsOn: ['srv'] },
      outer: { dependsOn: ['up'] },
      a: { dependsOn: ['srv'], exec: {
        command: 'touch stop; while kill -0 $(cat srv.pid) 2>/dev/null; do sleep 0.02; done',
      } },
      c: { dependsOn: ['outer', 'a'], exec: { command: 'touch c.ran' } },
    } }`,
  )
  const result = await run({ cwd: root, tasks: ['app#c'], log: silent, handleSignals: false })
  const c = result.outcomes.find((o) => o.node.id === 'app#c')
  expect([c?.status, c?.blockedBy]).toEqual(['skipped', 'app#srv'])
  expect(existsSync(join(root, 'packages/app/c.ran'))).toBe(false)
  expect(result.ok).toBe(false)
}, 20_000)
