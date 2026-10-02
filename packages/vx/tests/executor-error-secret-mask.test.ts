// An executor that throws puts its message in the task's stream, and the
// scheduler prints the error. vx-reapi's carries the remote server's own
// status text, which is not vx's to trust: a server that echoed the
// Command's env put a secret in both, unmasked beside a masked task
// output (L-39).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import type { TelemetryRecord } from '../src/index.js'

const SECRET = 'supersecretvalue123'
let root: string
let saved: string | undefined
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-exec-err-mask-' })
  saved = process.env.API_TOKEN
  process.env.API_TOKEN = SECRET
})
afterEach(async () => {
  if (saved === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = saved
  await rm(root, { recursive: true, force: true })
})

it("a thrown executor message is masked in the task's stream, the error and telemetry", async () => {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/echoer',
        `{ executor() { return { name: 'echoer', async execute(req) {
            throw new Error('server said: env API_TOKEN=' + process.env.API_TOKEN)
          } } } }`,
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
  const records: TelemetryRecord[] = []
  const r = await run({
    cwd: root,
    tasks: ['t'],
    projects: ['app'],
    log,
    handleSignals: false,
    telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
  })
  const said =
    "plugin 'org/echoer' (executor 'echoer') failed in execute: server said: env API_TOKEN=***"
  expect(lines.filter((l) => l.includes('server said'))).toEqual([
    `${said}\n`,
    `[vx] app#t: ${said}\n`,
  ])
  expect(
    JSON.stringify({ lines, records, outcomes: r.outcomes.map((o) => o.status) }).includes(SECRET),
  ).toBe(false)
})
