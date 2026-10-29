// A server whose `readyWhen` never matches held its dependants in
// silence: a dependency's output is hidden unless it fails, and with no
// `exec.timeout` the wait never ends, so a CI log showed nothing at all.
// vx now says once, after a while, what it is waiting for.

import { rm } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

let notice: string | undefined
beforeAll(() => {
  notice = process.env['VX_TEST_READY_NOTICE']
  process.env['VX_TEST_READY_NOTICE'] = '200ms'
})
afterAll(() => {
  if (notice === undefined) delete process.env['VX_TEST_READY_NOTICE']
  else process.env['VX_TEST_READY_NOTICE'] = notice
})
let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const runWith = async (command: string, timeout?: number) => {
  root = await makeWorkspace({ prefix: 'vx-ready-notice-' })
  const bound = timeout === undefined ? '' : `, timeout: '${timeout}ms'`
  await addProject(
    root,
    'app',
    `export default { tasks: {
      dev: { exec: { command: '${command}', persistent: { readyWhen: 'ready' }${bound} } },
      e2e: { dependsOn: ['dev'], exec: { command: 'true' } },
    } }`,
  )
  const lines: string[] = []
  const log: Logger = {
    status: (s) => void lines.push(s),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  await run({ cwd: root, tasks: ['app#e2e'], log, handleSignals: false })
  return lines.filter((l) => l.includes('not ready after'))
}

it('a server not ready in time is said once, with the pattern it waits for', async () => {
  expect(await runWith('echo listening; exec sleep 30', 1500)).toEqual([
    'vx: app#dev not ready after 200 ms: waiting for a line matching /ready/ (readyWhen)',
  ])
}, 20_000)

it('an unbounded wait says no exec.timeout bounds it', async () => {
  // Ready at 800 ms: past the notice, so the run ends on its own.
  expect(await runWith('echo listening; sleep 0.8; echo ready; exec sleep 30')).toEqual([
    'vx: app#dev not ready after 200 ms: waiting for a line matching /ready/ (readyWhen), with no exec.timeout',
  ])
}, 20_000)

// Control: a server ready before the notice is not said.
it('a server ready in time says nothing', async () => {
  expect(await runWith('echo ready; exec sleep 30')).toEqual([])
}, 20_000)

// The pattern in the command line is not output: a matcher fed the
// `$ command` header, or an echo of it, called the server ready at spawn.
it('a pattern only the command line holds is no readiness', async () => {
  expect(await runWith(': ready; echo listening; exec sleep 30', 1500)).toEqual([
    'vx: app#dev not ready after 200 ms: waiting for a line matching /ready/ (readyWhen)',
  ])
}, 20_000)

it('a task waiting on two servers names each one not ready', async () => {
  root = await makeWorkspace({ prefix: 'vx-ready-notice-' })
  const server = (n: string) =>
    `${n}: { exec: { command: 'echo booting; exec sleep 30', persistent: { readyWhen: 'up-${n}' }, timeout: '1500ms' } },`
  await addProject(
    root,
    'app',
    `export default { tasks: {
      ${server('s1')}
      ${server('s2')}
      e2e: { dependsOn: ['s1', 's2'], exec: { command: 'true' } },
    } }`,
  )
  const lines: string[] = []
  const log: Logger = {
    status: (s) => void lines.push(s),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  await run({ cwd: root, tasks: ['app#e2e'], log, handleSignals: false })
  expect(lines.filter((l) => l.includes('not ready after')).sort()).toEqual([
    'vx: app#s1 not ready after 200 ms: waiting for a line matching /up-s1/ (readyWhen)',
    'vx: app#s2 not ready after 200 ms: waiting for a line matching /up-s2/ (readyWhen)',
  ])
}, 20_000)
