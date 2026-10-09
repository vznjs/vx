// `vx last --log <task>`: one task's output from the history, so an agent
// reads a passing task's log too, not only a failure's.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const runIds: Record<string, string> = {}
const lastRunId = (): string =>
  (JSON.parse(vx('last', '--format', 'json').out) as { invocation: { runId: string } }).invocation
    .runId

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-log-' })
  await addProject(
    root,
    'a',
    `const cache = { inputs: { files: ['package.json'] }, outputs: { files: [] } }
export default { tasks: {
  build: { exec: { command: 'echo built-ok' }, cache },
  plain: { exec: { command: 'echo plain' } },
  bad: { exec: { command: 'echo boom; exit 3' } },
} }
`,
  )
  expect(vx('run', 'a#build').code).toBe(0)
  runIds['miss'] = lastRunId()
  expect(vx('run', 'a#build').code).toBe(0)
  expect(vx('run', 'a#plain').code).toBe(0)
  expect(vx('run', 'a#bad').code).toBe(1)
  runIds['bad'] = lastRunId()
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("a cached task's log comes from its entry, on the hit and in the run that saved it", () => {
  expect(vx('last', '--log', 'a#build')).toEqual({ code: 0, out: 'built-ok\n', err: '' })
  const saved = JSON.parse(vx('last', runIds['miss']!, '--log=a#build', '--format', 'json').out)
  expect(saved).toEqual({
    runId: runIds['miss'],
    taskId: 'a#build',
    status: 'success',
    source: 'cache',
    output: 'built-ok\n',
  })
})

it("a failed task's log is its kept failure output", () => {
  expect(JSON.parse(vx('last', '--log', 'a#bad', '--format', 'json').out)).toEqual({
    runId: runIds['bad'],
    taskId: 'a#bad',
    status: 'failed',
    source: 'failure',
    output: 'boom\n',
  })
})

it('an uncached pass kept none, and says so on stderr', () => {
  expect(vx('last', '--log', 'a#plain')).toEqual({
    code: 0,
    out: '',
    err: 'vx last: a#plain ended success; vx keeps output only for failed and cached tasks\n',
  })
})

it('a task no run recorded, or one outside the run named, is refused', () => {
  expect(vx('last', '--log', 'a#nope')).toEqual({
    code: 1,
    out: '',
    err: 'vx last: no recorded run of a#nope (a task id is project#task)\n',
  })
  expect(vx('last', runIds['bad']!, '--log', 'a#build').code).toBe(1)
})

it('--log takes a task id and combines only with a run id', () => {
  expect(vx('last', '--log').err).toContain('--log requires a task id')
  expect(vx('last', '--log', 'a#bad', '--list').err).toContain('combines only with a run id')
  expect(vx('last', '--log', 'a#bad', '--failed').err).toContain('combines only with a run id')
})
