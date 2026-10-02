// A plugin's `ctx.warn` line reaches the run's status channel. A remote
// layer warns with the server's own reply (vx-reapi's "could not record
// execution: …", a cache layer's error), which may echo what it was sent:
// a secret there printed whole beside a masked task output (L-40).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const SECRET = 'supersecretvalue123'
let root: string
let saved: string | undefined
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-warn-mask-' })
  saved = process.env.API_TOKEN
  process.env.API_TOKEN = SECRET
})
afterEach(async () => {
  if (saved === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = saved
  await rm(root, { recursive: true, force: true })
})

it("a plugin's warning is masked", async () => {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/warner',
        `{ executor(ctx) { ctx.warn('server said: token=' + process.env.API_TOKEN); return undefined } }`,
      ),
    ]),
  )
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const lines: string[] = []
  const log: Logger = {
    status: (m) => void lines.push(m),
    taskStdout: (_n, t) => void lines.push(t),
    taskStderr: (_n, t) => void lines.push(t),
    taskComplete() {},
  }
  await run({ cwd: root, tasks: ['t'], projects: ['app'], log, handleSignals: false })
  expect(lines.filter((l) => l.includes('server said'))).toEqual(['server said: token=***'])
  expect(lines.join('\n').includes(SECRET)).toBe(false)
})
