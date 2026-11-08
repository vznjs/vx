// A server that depends on a server: what the lower one does reaches the
// tasks on top. A task behind `web` runs against `api` too, so `api`'s
// death blocks and taints it as a direct dependant's; and a warm run
// whose hits need `web` alone needs neither.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { planRun, run } from './helpers/orchestrator.js'

process.env['VX_TEST_KILL_GRACE'] = '200ms'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

// `api` waits for `stop`, then exits 7; `web` stays up on top of it.
const servers = `
  api: { exec: {
    command: 'echo $$ > api.pid; echo ready; while [ ! -f stop ]; do sleep 0.02; done; exit 7',
    persistent: { readyWhen: 'ready' },
  }, inputs: { files: [] } },
  web: { dependsOn: ['api'], exec: {
    command: 'echo ready; exec sleep 30',
    persistent: { readyWhen: 'ready' },
  }, inputs: { files: [] } },`
const killApi = 'touch stop; while kill -0 $(cat api.pid) 2>/dev/null; do sleep 0.02; done'

it('a task behind a server is not saved when the server below it dies', async () => {
  root = await makeWorkspace({ prefix: 'vx-server-chain-' })
  await addProject(
    root,
    'app',
    `export default { tasks: {${servers}
      e2e: { dependsOn: ['web'], cache: true, inputs: { files: [] }, outputs: { files: ['out.txt'] },
        exec: { command: '${killApi}; echo built > out.txt' } },
    } }`,
  )
  const result = await run({ cwd: root, tasks: ['app#e2e'], log: silent, handleSignals: false })
  expect(result.ok).toBe(false)
  await rm(join(root, 'packages/app/stop'), { force: true })
  const planned = await planRun({ cwd: root, tasks: ['app#e2e'], log: silent })
  expect(planned.tasks.find((t) => t.node.id === 'app#e2e')?.cacheStatus).toBe('miss')
}, 30_000)

it('a task behind a server skips when the server below it dies', async () => {
  root = await makeWorkspace({ prefix: 'vx-server-chain-' })
  await addProject(
    root,
    'app',
    `export default { tasks: {${servers}
      a: { dependsOn: ['api'], exec: { command: '${killApi}' } },
      c: { dependsOn: ['web', 'a'], exec: { command: 'touch c.ran' } },
    } }`,
  )
  const result = await run({ cwd: root, tasks: ['app#c'], log: silent, handleSignals: false })
  const c = result.outcomes.find((o) => o.node.id === 'app#c')
  expect([c?.status, c?.blockedBy]).toEqual(['skipped', 'app#api'])
  expect(existsSync(join(root, 'packages/app/c.ran'))).toBe(false)
}, 30_000)

// `api` in a project of its own: an uncached server may write anywhere in
// its project, so beside `web` it leaves `web`'s key preliminary, and with
// it every key above (stable-keys.ts).
it('a server only an idle server needs is not started either', async () => {
  root = await makeWorkspace({ prefix: 'vx-server-chain-' })
  const server = (name: string) =>
    `exec: { command: 'echo ${name} >> ../../boots.log; echo ready; exec sleep 30',
      persistent: { readyWhen: 'ready' } }, inputs: { files: [] }`
  await addProject(root, 'api', `export default { tasks: { dev: { ${server('api')} } } }`)
  await addProject(
    root,
    'web',
    `export default { tasks: { dev: { dependsOn: ['api#dev'], ${server('web')} } } }`,
  )
  await addProject(
    root,
    't',
    `export default { tasks: {
      e2e: { dependsOn: ['web#dev'], cache: true, inputs: { files: [] }, outputs: { files: [] },
        exec: { command: 'true' } },
    } }`,
  )
  const go = async () =>
    (await run({ cwd: root!, tasks: ['t#e2e'], log: silent, handleSignals: false })).outcomes
      .map((o) => `${o.node.id} ${o.status}`)
      .sort()
  expect(await go()).toEqual(['api#dev success', 't#e2e success', 'web#dev success'])
  const planned = await planRun({ cwd: root, tasks: ['t#e2e'], log: silent })
  expect(planned.tasks.map((t) => `${t.node.id} ${t.cacheStatus}`).sort()).toEqual([
    'api#dev not-started',
    't#e2e hit-local',
    'web#dev not-started',
  ])
  expect(await go()).toEqual(['t#e2e cache-hit'])
  expect(await Bun.file(join(root, 'boots.log')).text()).toBe('api\nweb\n')
}, 30_000)
