// `PluginSetupContext` declares `warn`, as every other hook's context
// does, but the context `setup()` received had none: a plugin that warned
// from setup failed the run with "ctx.warn is not a function".
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-setup-warn-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it("setup()'s ctx.warn reaches the run's status lines", async () => {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/warner', `{ setup(ctx) { ctx.warn('warned from setup') } }`),
    ]),
  )
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const lines: string[] = []
  const log: Logger = {
    status: (m) => void lines.push(m),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  const r = await run({ cwd: root, tasks: ['t'], projects: ['app'], log, handleSignals: false })
  expect({ ok: r.ok, warned: lines.filter((l) => l.includes('warned from setup')) }).toEqual({
    ok: true,
    warned: ['warned from setup'],
  })
})
