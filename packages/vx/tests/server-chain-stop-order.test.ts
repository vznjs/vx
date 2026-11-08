// A server that uses another stops before it: its shutdown may still talk
// to the one it uses (flush to a database, deregister from a broker). Both
// were signalled at once, so the server it used was gone while its TERM
// handler still ran.

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { serverUsers } from '../src/orchestrator/persistent.js'
import type { TaskNode } from '../src/graph/index.js'

process.env['VX_TEST_KILL_GRACE'] = '2s'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-server-chain-stop-' })
  // `api` takes a while to shut down; `db` notes when its own stop lands.
  await addProject(
    root,
    'app',
    `export default { tasks: {
      db: { exec: {
        command: "trap 'echo db >> ../../stops; exit 0' TERM; echo ready; while :; do sleep 0.02; done",
        persistent: { readyWhen: 'ready' },
      } },
      api: { dependsOn: ['db'], exec: {
        command: "trap 'sleep 0.3; echo api >> ../../stops; exit 0' TERM; echo ready; while :; do sleep 0.02; done",
        persistent: { readyWhen: 'ready' },
      } },
      t: { dependsOn: ['api'], exec: { command: 'true' } },
    } }`,
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const stops = () => readFileSync(join(root, 'stops'), 'utf8').trim().split('\n')

it('a server its last user no longer needs stops after the server using it', async () => {
  const r = await run({ cwd: root, tasks: ['app#t'], log: silent, handleSignals: false })
  expect(r.ok).toBe(true)
  expect(stops()).toEqual(['api', 'db'])
}, 30_000)

it('the end of the graph stops a server after the server using it', async () => {
  // Nothing but a server uses `db`, and `api` has no user: both stop at the end.
  const r = await run({ cwd: root, tasks: ['app#api'], log: silent, handleSignals: false })
  expect(r.ok).toBe(true)
  expect(stops()).toEqual(['api', 'db'])
}, 30_000)

it('serverUsers reads a server through groups, and only servers use one', () => {
  const node = (id: string, deps: string[], config: Record<string, unknown>) =>
    [id, { id, deps, config } as unknown as TaskNode] as const
  const server = { exec: { command: 'x', persistent: {} } }
  const nodes = new Map([
    node('db', [], server),
    node('cache', [], server),
    node('infra', ['db', 'cache'], {}),
    node('api', ['infra'], server),
    node('worker', ['db'], server),
    node('t', ['api', 'db'], { exec: { command: 'x' } }),
  ])
  expect(Object.fromEntries(serverUsers(nodes))).toEqual({
    db: ['api', 'worker'],
    cache: ['api'],
  })
})
