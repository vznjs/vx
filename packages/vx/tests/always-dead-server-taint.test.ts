// Under `--continue=always` a task downstream of a failure runs but is
// never saved: its key is the one a healthy run derives, and its bytes
// were built on a partial tree. A server that died mid-run is such a
// failure (C-88), yet its outcome said `success` from the moment it was
// ready, so a dependant dispatched after the death, and every task built
// on it, saved under healthy keys, and the next healthy run replayed them.

import { rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const cached = (out: string) =>
  `cache: { inputs: { files: ['vx.config.mjs'] }, outputs: { files: ['${out}'] } }`

it('what starts after its server died is not saved under --continue=always', async () => {
  root = await makeWorkspace({ prefix: 'vx-always-dead-' })
  // The server dies only while `crash` (outside every key) exists; `a`
  // asks it to, then waits until vx has reaped it.
  await addProject(
    root,
    'app',
    `export default { tasks: {
      srv: { exec: {
        command: 'echo $$ > ../../srv.pid; echo ready; [ -f ../../crash ] || exec sleep 30; while [ ! -f ../../stop ]; do sleep 0.02; done; exit 7',
        persistent: { readyWhen: 'ready' },
      } },
      a: { dependsOn: ['srv'], exec: {
        command: 'touch ../../stop; [ -f ../../crash ] || exit 0; while kill -0 $(cat ../../srv.pid) 2>/dev/null; do sleep 0.02; done',
      } },
    } }`,
  )
  // Built in their own project: what they write must not move the keys of
  // the uncached tasks above, which read their whole project.
  await addProject(
    root,
    'web',
    `export default { tasks: {
      c: { dependsOn: ['app#srv', 'app#a'], exec: { command: 'echo built > c.out' }, ${cached('c.out')} },
      d: { dependsOn: ['c'], exec: { command: 'echo built > d.out' }, ${cached('d.out')} },
    } }`,
  )
  const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))

  await writeFile(join(root, 'crash'), '')
  const failing = await run({
    cwd: root,
    tasks: ['web#d'],
    continueMode: 'always',
    log: silent,
    handleSignals: false,
  })
  expect(statusOf(failing)).toEqual({
    'app#srv': 'failed',
    'app#a': 'success',
    'web#c': 'success',
    'web#d': 'success',
  })

  await unlink(join(root, 'crash'))
  await unlink(join(root, 'stop'))
  const healthy = await run({ cwd: root, tasks: ['web#d'], log: silent, handleSignals: false })
  expect([healthy.ok, statusOf(healthy)['web#c'], statusOf(healthy)['web#d']]).toEqual([
    true,
    'success',
    'success',
  ])
}, 30_000)
