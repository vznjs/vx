// A task that ran while a server it depends on died is not saved: its key
// is the one a healthy run derives, and its bytes were built against a
// dead server. The save was decided at dispatch, when the server still
// served, so the run failed on the crash yet saved the dependant, and the
// next run, its server healthy, was up-to-date without ever asking it.

import { rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

process.env['VX_TEST_KILL_GRACE'] = '200ms'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const cached = (out: string) =>
  `inputs: { files: ['vx.config.mjs'] }, outputs: { files: ['${out}'] }, cache: true`
const statusOf = (r: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))

// The server dies only while `crash` (outside every key) exists.
async function workspace(srv: string, b: string): Promise<string> {
  const dir = await makeWorkspace({ prefix: 'vx-server-died-under-' })
  await addProject(
    dir,
    'srvp',
    `export default { tasks: {
      srv: { exec: { command: ${JSON.stringify(srv)}, persistent: { readyWhen: 'ready' } }, inputs: { files: ['vx.config.mjs'] } },
    } }`,
  )
  await addProject(
    dir,
    'app',
    `export default { tasks: {
      b: { dependsOn: ['srvp#srv'], exec: { command: ${JSON.stringify(b)} }, ${cached('b.out')} },
      c: { dependsOn: ['b'], exec: { command: 'echo built > c.out' }, ${cached('c.out')} },
    } }`,
  )
  return dir
}

async function crashThenHeal(dir: string): Promise<void> {
  await writeFile(join(dir, 'crash'), '')
  const failing = await run({ cwd: dir, tasks: ['app#c'], log: silent, handleSignals: false })
  expect(failing.ok).toBe(false)
  expect(statusOf(failing)).toEqual({
    'srvp#srv': 'failed',
    'app#b': 'success',
    'app#c': 'success',
  })
  // `b` ran against the dead server, `c` on `b`'s bytes.
  expect(Object.fromEntries(failing.outcomes.map((o) => [o.node.id, o.taintedBy]))).toEqual({
    'srvp#srv': undefined,
    'app#b': 'srvp#srv',
    'app#c': 'app#b',
  })

  await unlink(join(dir, 'crash'))
  const healthy = await run({ cwd: dir, tasks: ['app#c'], log: silent, handleSignals: false })
  expect([healthy.ok, statusOf(healthy)['app#b'], statusOf(healthy)['app#c']]).toEqual([
    true,
    'success',
    'success',
  ])
}

it('a task its server died under is not saved, nor what is built on it', async () => {
  // `b` tells the server to die, then waits until vx has reaped it.
  root = await workspace(
    'echo $$ > ../../srv.pid; echo ready; [ -f ../../crash ] || exec sleep 30; while [ ! -f ../../go ]; do sleep 0.02; done; exit 3',
    'echo built > b.out; [ -f ../../crash ] || exit 0; touch ../../go; while kill -0 $(cat ../../srv.pid) 2>/dev/null; do sleep 0.02; done',
  )
  await crashThenHeal(root)
}, 30_000)

it('a server that dies just before its task ends holds the save too', async () => {
  // `b` kills the server and ends the moment the kernel holds it dead (a
  // zombie, or already reaped): vx may hear `b`'s end first.
  root = await workspace(
    'echo $$ > ../../srv.pid; echo ready; exec sleep 30',
    'echo built > b.out; [ -f ../../crash ] || exit 0; pid=$(cat ../../srv.pid); kill -9 $pid; ' +
      'while s=$(ps -o stat= -p $pid); [ -n "$s" ] && [ "${s#Z}" = "$s" ]; do :; done',
  )
  await crashThenHeal(root)
}, 30_000)
