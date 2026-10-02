// Telemetry carries the run's command line (`vx.command` on the OTLP run
// span, the GitHub job summary). What follows `--` is counted, but a
// secret before it (`--tag key=$DEPLOY_KEY`) was sent whole: the stored
// invocation and the tags were masked (L-35, L-38), this line was not
// (L-44).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { run, type TelemetryRecord } from '../src/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'

const SECRET = 'supersecretvalue123'
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('the command line telemetry receives is masked', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-tel-cmd-mask-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: { deploy: { exec: { command: 'true' } } } }\n`,
  )
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
  const records: TelemetryRecord[] = []
  const prev = process.env.DEPLOY_KEY
  process.env.DEPLOY_KEY = SECRET
  try {
    await run({
      cwd: root,
      tasks: ['a#deploy'],
      command: `vx run a#deploy --tag key=${SECRET} -- --x`,
      log: defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true }),
      handleSignals: false,
      telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
    })
  } finally {
    if (prev === undefined) delete process.env.DEPLOY_KEY
    else process.env.DEPLOY_KEY = prev
  }
  expect(records.flatMap((r) => (r.kind === 'run.start' ? [r.run.command] : []))).toEqual([
    'vx run a#deploy --tag key=*** -- <1 argument>',
  ])
  expect(JSON.stringify(records).includes(SECRET)).toBe(false)
})
