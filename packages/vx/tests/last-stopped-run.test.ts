// A run stopped with Ctrl-C keeps no `invocations` header (item 854) but
// does keep what finished: a failed task's output, and a run id the readers
// that print it also accept back.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
let dir: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const stopAfterSlowStarts = async (...tasks: string[]): Promise<void> => {
  const pid = path.join(dir, 'pid.txt')
  await rm(pid, { force: true })
  const proc = Bun.spawn([process.execPath, BIN, 'run', ...tasks, '--continue'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  for (let i = 0; i < 200 && !(await Bun.file(pid).exists()); i++) await Bun.sleep(50)
  await Bun.sleep(500)
  proc.kill('SIGINT')
  expect(await proc.exited).toBe(130)
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-stopped-' })
  dir = await addProject(
    root,
    'a',
    `export default { tasks: {
  bad: { exec: { command: 'echo boom; exit 3' } },
  build: { exec: { command: 'echo built' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } },
  slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
} }
`,
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a failed task of a stopped run keeps its output for `vx last --log`', async () => {
  await stopAfterSlowStarts('a#bad', 'a#slow')
  const log = JSON.parse(vx('last', '--log', 'a#bad', '--format', 'json').out)
  expect({ status: log.status, source: log.source, output: log.output }).toEqual({
    status: 'failed',
    source: 'failure',
    output: 'boom\n',
  })
}, 30_000)

it('`vx why --run` accepts the stopped run id `vx last --log` printed', async () => {
  await stopAfterSlowStarts('a#build', 'a#slow')
  const log = JSON.parse(vx('last', '--log', 'a#build', '--format', 'json').out) as {
    runId: string
  }
  const why = vx('why', 'a#build', '--run', log.runId)
  expect({ code: why.code, err: why.err }).toEqual({ code: 0, err: '' })
}, 30_000)
