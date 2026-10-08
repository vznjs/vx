// A plugin's `execute` is typed async, but a plain function that throws
// before it returns, or returns the result object itself, is what a plugin
// author writes by accident. Core treats the throw as the rejection and the
// bare value as the resolution, so the failure names the plugin and the
// timers and listeners around the call are still cleaned up.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-exec-sync-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runWith(
  execute: string,
  timeout = '',
): Promise<{ lines: string[]; statuses: string[] }> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/sync', `{ executor() { return { name: 'sync', ${execute} } } }`),
    ]),
  )
  await addProject(
    root,
    'app',
    `export default { tasks: { t: { exec: { command: 'true'${timeout} } } } }`,
  )
  const lines: string[] = []
  const log: Logger = {
    status: (m) => void lines.push(m),
    taskStdout: (_n, t) => void lines.push(t),
    taskStderr: (_n, t) => void lines.push(t),
    taskComplete() {},
  }
  const r = await run({ cwd: root, tasks: ['t'], projects: ['app'], log, handleSignals: false })
  return { lines, statuses: r.outcomes.map((o) => o.status) }
}

const RESULT = `{ exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }`

for (const timeout of ['', ', timeout: 60000']) {
  const label = timeout === '' ? '' : ' (with a timeout signal)'

  it(`a synchronous throw from execute fails the task naming the plugin${label}`, async () => {
    const { lines, statuses } = await runWith(`execute(req) { throw new Error('boom') }`, timeout)
    const said = "plugin 'org/sync' (executor 'sync') failed in execute: boom"
    expect(lines.filter((l) => l.includes('boom'))).toEqual([`[vx] app#t: ${said}\n`])
    expect(statuses).toEqual(['failed'])
  })

  it(`a non-Promise result from execute is taken as the resolved one${label}`, async () => {
    const { statuses } = await runWith(`execute(req) { return ${RESULT} }`, timeout)
    expect(statuses).toEqual(['success'])
  })
}
