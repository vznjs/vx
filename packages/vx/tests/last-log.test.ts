// `vx last --log <task>`: one task's output from the history, so an agent
// reads a passing task's log too, not only a failure's.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

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
    `const cache = { outputs: { files: [] } }
const inputs = { files: ['package.json'] }
export default { tasks: {
  build: { exec: { command: 'echo built-ok' }, inputs, cache },
  plain: { exec: { command: 'echo plain' } },
  bad: { exec: { command: 'echo boom; exit 3' } },
  quiet: { exec: { command: 'true' }, inputs, cache },
  mute: { exec: { command: 'exit 4' } },
  unsaved: { exec: { command: 'echo unsaved' }, inputs, cache },
} }
`,
  )
  expect(vx('run', 'a#build').code).toBe(0)
  runIds['miss'] = lastRunId()
  expect(vx('run', 'a#build').code).toBe(0)
  expect(vx('run', 'a#plain').code).toBe(0)
  expect(vx('run', 'a#bad').code).toBe(1)
  runIds['bad'] = lastRunId()
  expect(vx('run', 'a#quiet').code).toBe(0)
  expect(vx('run', 'a#mute').code).toBe(1)
  await addProject(
    root,
    'b',
    `export default { tasks: { build: { exec: { command: 'echo b' } }, own: { exec: { command: 'echo own' } } } }\n`,
  )
  expect(vx('run', 'b#build').code).toBe(0)
  expect(vx('run', 'b#own').code).toBe(0)
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
    err: noticed(
      'vx last: a#plain ended success. vx keeps output only for failed and cached tasks\n',
      'info',
    ),
  })
})

it('a cached or failed task that printed nothing says so, not that its output was not kept', () => {
  for (const [task, status, source] of [
    ['a#quiet', 'success', 'cache'],
    ['a#mute', 'failed', 'failure'],
  ] as const) {
    expect(vx('last', '--log', task)).toEqual({
      code: 0,
      out: '',
      err: noticed(`vx last: ${task} ended ${status} and printed nothing\n`, 'info'),
    })
    expect(JSON.parse(vx('last', '--log', task, '--format', 'json').out).source).toBe(source)
  }
})

it('a failed task whose kept failures were pruned says so, not that it printed nothing', async () => {
  const kept = path.join(root, '.vx', 'cache', 'failures', `${runIds['bad']}.json`)
  const bytes = await Bun.file(kept).bytes()
  await rm(kept)
  try {
    expect(vx('last', runIds['bad']!, '--log', 'a#bad')).toEqual({
      code: 0,
      out: '',
      err: noticed(
        'vx last: a#bad ended failed, and vx kept no output for it: it keeps the newest 50 failed runs\n',
        'info',
      ),
    })
  } finally {
    await Bun.write(kept, bytes)
  }
})

it('a task no run recorded, or one outside the run named, is refused', () => {
  expect(vx('last', '--log', 'a#nope')).toEqual({
    code: 1,
    out: '',
    err: noticed('vx last: no recorded run of a#nope\n'),
  })
  expect(vx('last', runIds['bad']!, '--log', 'a#build').code).toBe(1)
  // No history of it, as `--stats` and `vx why` say it: it was VX_E_REFUSED.
  expect(JSON.parse(vx('last', '--log', 'a#nope', '--format', 'json').out).error.code).toBe(
    'VX_E_NO_HISTORY',
  )
})

it('--log with no value reads the positional argument as the task', () => {
  const asFlag = vx('last', '--log', 'a#bad', '--format', 'json')
  expect(vx('last', 'a#bad', '--log', '--format', 'json')).toEqual(asFlag)
  expect(vx('last', 'a#bad', '--log').out).toBe('boom\n')
})

it('--log takes a task id and combines only with a run id', () => {
  expect(vx('last', '--log').err).toContain('--log requires a task id')
  expect(vx('last', '--log', 'a#bad', '--list').err).toContain('combines only with a run id')
  expect(vx('last', '--log', 'a#bad', '--failed').err).toContain('combines only with a run id')
})

it('--log takes a bare task name: the one project that ran it, else the ones to pick', () => {
  expect(vx('last', '--log', 'own')).toEqual({
    code: 0,
    out: '',
    err: noticed(
      'vx last: b#own ended success. vx keeps output only for failed and cached tasks\n',
      'info',
    ),
  })
  expect(vx('last', '--log', 'build')).toEqual({
    code: 1,
    out: '',
    err: noticed('vx last: "build" ran in 2 projects — pick one:\n  a#build\n  b#build\n'),
  })
})

it('a cached task whose run saved no entry says so, not that it is uncached', () => {
  expect(vx('run', 'a#unsaved', '--cache-policy', 'local:r').code).toBe(0)
  expect(vx('last', '--log', 'a#unsaved')).toEqual({
    code: 0,
    out: '',
    err: noticed(
      'vx last: a#unsaved ended success, and its entry is not in the cache: the run did not save it, or it was pruned since\n',
      'info',
    ),
  })
})

// An entry saved before masking, or by another machine, can hold a value
// this machine's env names a secret: a hit's replay masks it, and so does
// the log `vx last` reads from the entry.
it("a cached task's log masks this process's secret values, as its replay does", () => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'last', '--log', 'a#build'],
    cwd: root,
    env: { ...process.env, PROBE_TOKEN: 'built-ok' },
  })
  expect([p.exitCode, p.stdout.toString()]).toEqual([0, '***\n'])
})

// Turbo #6267: a log file named after `build:prod` broke on Windows. vx
// names no file after a task; a colon runs, caches, restores and reads back.
it('a task named with a colon saves, restores and reads back its log', async () => {
  const dir = await addProject(
    root,
    'c',
    `export default { tasks: { 'build:prod': { exec: { command: 'echo r >> runs.txt && mkdir -p dist && echo p > dist/o && echo prod-ok' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: ['dist/**'] } } } } }\n`,
  )
  expect(vx('run', 'c#build:prod').code).toBe(0)
  await rm(path.join(dir, 'dist'), { recursive: true })
  const hit = vx('run', 'c#build:prod')
  expect([hit.code, hit.out + hit.err]).toEqual([0, expect.stringContaining('prod-ok')])
  expect(await Bun.file(path.join(dir, 'dist', 'o')).text()).toBe('p\n')
  expect(await Bun.file(path.join(dir, 'runs.txt')).text()).toBe('r\n')
  expect(vx('last', '--log', 'c#build:prod')).toEqual({ code: 0, out: 'prod-ok\n', err: '' })
})
