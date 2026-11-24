// Telemetry carries the run's command line (`vx.command` on the OTLP run
// span, the GitHub job summary). What follows `--` is counted, but a
// secret before it (`--branch $DEPLOY_KEY`) was sent whole: the stored
// invocation was masked (L-35), this line was not (L-44).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { type TelemetryRecord } from '../src/index.js'
import { run } from './helpers/orchestrator.js'
import { defaultLogger } from '../src/report/logger.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

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
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
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
      command: `vx run a#deploy --branch ${SECRET} -- --x`,
      log: defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true }),
      handleSignals: false,
      telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
    })
  } finally {
    if (prev === undefined) delete process.env.DEPLOY_KEY
    else process.env.DEPLOY_KEY = prev
  }
  expect(records.flatMap((r) => (r.kind === 'run.start' ? [r.run.command] : []))).toEqual([
    'vx run a#deploy --branch *** -- <1 argument>',
  ])
  expect(JSON.stringify(records).includes(SECRET)).toBe(false)
})

// Each task's command is masked against the env as it is at that task, and
// its own `define`: a mask built once a run (aa357a07a) missed a secret a
// plugin put in the env after the run's first task.
it('each task start masks its own secrets and the env as it is then', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tel-cmd-mask-per-task-'))
  const OWN = 'owndefinedsecret456'
  const LATE = 'latearrivingsecret789'
  try {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await Bun.write(path.join(dir, '.vx/workspace.mjs'), localWorkspaceSource())
    const pkg = path.join(dir, 'packages', 'a')
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(pkg, 'vx.config.mjs'),
      `export default { tasks: {
        zero: { exec: { command: 'true' } },
        one: { dependsOn: ['zero'], exec: { command: 'echo ${OWN}', env: { define: { ONE_TOKEN: '${OWN}' } } } },
        two: { dependsOn: ['one'], exec: { command: 'echo ${LATE} ${OWN}' } },
      } }\n`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: dir }).exitCode).toBe(0)
    const records: TelemetryRecord[] = []
    try {
      await run({
        cwd: dir,
        tasks: ['a#two'],
        log: defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true }),
        handleSignals: false,
        telemetrySinks: [
          {
            onRecord: (rec) => {
              records.push(rec)
              if (rec.kind === 'task.end' && rec.taskId === 'a#one') process.env.LATE_TOKEN = LATE
            },
          },
        ],
      })
    } finally {
      delete process.env.LATE_TOKEN
    }
    const commands = Object.fromEntries(
      records.flatMap((r) => (r.kind === 'task.start' ? [[r.taskId, r.command]] : [])),
    )
    expect(commands).toEqual({
      'a#zero': 'true',
      'a#one': 'echo ***',
      'a#two': `echo *** ${OWN}`,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
