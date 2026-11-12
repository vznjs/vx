// `vx last --log <task>`: one task's output from the history, so an agent
// reads a passing task's log too, not only a failure's.
import { Database } from 'bun:sqlite'
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
    `const outputs = { files: [] }
const inputs = { files: ['package.json'] }
export default { tasks: {
  build: { exec: { command: 'echo built-ok' }, inputs, outputs, cache: true },
  plain: { exec: { command: 'echo plain' } },
  bad: { exec: { command: 'echo boom; exit 3' } },
  quiet: { exec: { command: 'true' }, inputs, outputs, cache: true },
  mute: { exec: { command: 'exit 4' } },
  unsaved: { exec: { command: 'echo unsaved' }, inputs, outputs, cache: true },
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
  await addProject(
    root,
    'c',
    `export default { tasks: { gate: { exec: { command: 'exit 2' } }, after: { dependsOn: ['gate'], exec: { command: 'echo after' } } } }\n`,
  )
  expect(vx('run', 'c#after').code).toBe(1)
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

it('a failed task whose kept failures were pruned says so, not that it printed nothing', () => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  const kept = db.query('SELECT * FROM failures WHERE run_id = ?').all(runIds['bad']!) as Record<
    string,
    string | null
  >[]
  expect(kept.length).toBe(1)
  db.run('DELETE FROM failures WHERE run_id = ?', [runIds['bad']!])
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
    for (const r of kept)
      db.run(
        'INSERT INTO failures(run_id, task_id, input_moved, output, locations, sandbox_fix) VALUES (?, ?, ?, ?, ?, ?)',
        [
          r['run_id']!,
          r['task_id']!,
          r['input_moved'] ?? null,
          r['output']!,
          r['locations']!,
          r['sandbox_fix'] ?? null,
        ],
      )
    db.close()
  }
})

it('a task no run recorded, or one outside the run named, is refused', () => {
  expect(vx('last', '--log', 'a#nope')).toEqual({
    code: 1,
    out: '',
    // No near name: what of `a` ran, to pick from.
    err: noticed(
      "vx last: no recorded run of a#nope; a's recorded tasks: bad, build, mute, plain, quiet\n",
    ),
  })
  expect(vx('last', runIds['bad']!, '--log', 'a#build').code).toBe(1)
  // A typo of a task that ran is named, as `vx why` names it.
  expect(vx('last', '--log', 'a#biuld').err).toBe(
    noticed('vx last: no recorded run of a#biuld — did you mean a#build?\n'),
  )
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
      'vx last: a#unsaved ended success, and the cache does not hold its output: the run did not save it, or it was pruned or saved over since\n',
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
    `export default { tasks: { 'build:prod': { exec: { command: 'echo r >> runs.txt && mkdir -p dist && echo p > dist/o && echo prod-ok' }, inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
  )
  expect(vx('run', 'c#build:prod').code).toBe(0)
  await rm(path.join(dir, 'dist'), { recursive: true })
  const hit = vx('run', 'c#build:prod')
  expect([hit.code, hit.out + hit.err]).toEqual([0, expect.stringContaining('prod-ok')])
  expect(await Bun.file(path.join(dir, 'dist', 'o')).text()).toBe('p\n')
  expect(await Bun.file(path.join(dir, 'runs.txt')).text()).toBe('r\n')
  expect(vx('last', '--log', 'c#build:prod')).toEqual({ code: 0, out: 'prod-ok\n', err: '' })
})

// "ended skipped. vx keeps output only for failed and cached tasks" was a
// dead end: the output to read is its blocker's.
it("a skipped task's log points at what blocked it", () => {
  expect(vx('last', '--log', 'c#after')).toEqual({
    code: 0,
    out: '',
    err: noticed(
      'vx last: c#after did not run: c#gate blocked it (vx last --log c#gate)\n',
      'info',
    ),
  })
})

// The entry is the key's, not the run's: a `--force` run keeps the entry it
// finds, and an evicted key saved again holds the later run's output. Each
// run's log is its own, or says it was not kept, never another run's.
it("a run's log is its own output, never another run's saved under its key", async () => {
  await addProject(
    root,
    'd',
    `export default { tasks: { v: { exec: { command: 'echo out-$(date +%s%N)' }, inputs: { files: ['package.json'] }, outputs: { files: [] }, cache: true } } }\n`,
  )
  const logOf = (runId: string) =>
    JSON.parse(vx('last', runId, '--log', 'd#v', '--format', 'json').out) as {
      source: string | null
      output: string
    }
  const notKeptAs = (status: string) => ({
    code: 0,
    out: '',
    err: noticed(
      `vx last: d#v ended ${status}, and the cache does not hold its output: the run did not save it, or it was pruned or saved over since\n`,
      'info',
    ),
  })
  const notKept = notKeptAs('success')
  expect(vx('run', 'd#v').code).toBe(0)
  const first = lastRunId()
  const firstLog = logOf(first)
  expect(firstLog).toMatchObject({ source: 'cache', output: expect.stringMatching(/^out-\d+\n$/) })
  // --force: the kept entry is the first run's, and the summary saves none.
  const forced = vx('run', 'd#v', '--force')
  expect(forced.code).toBe(0)
  expect(forced.out + forced.err).not.toContain('1↑')
  const force = lastRunId()
  expect(vx('last', force, '--log', 'd#v')).toEqual(notKept)
  expect(logOf(first)).toEqual(firstLog)
  // A hit replays the first run's entry: its log.
  expect(vx('run', 'd#v').code).toBe(0)
  const hit = lastRunId()
  expect(logOf(hit)).toMatchObject({ source: 'cache', output: firstLog.output })
  // Evicted, then saved by a later run: that output is the later run's alone.
  expect(vx('cache', 'clean', '--max-size', '1B').code).toBe(0)
  expect(vx('run', 'd#v').code).toBe(0)
  const later = logOf(lastRunId())
  expect(later.source).toBe('cache')
  expect(later.output).not.toBe(firstLog.output)
  expect(vx('last', first, '--log', 'd#v')).toEqual(notKept)
  expect(vx('last', hit, '--log', 'd#v')).toEqual(notKeptAs('cache-hit'))
})

// A scoped project asked without its scope was named only as not run;
// `vx why` offers the scoped id.
it('a task id without its project scope is offered the scoped one', async () => {
  await addProject(
    root,
    '@w/envy',
    `export default { tasks: { probe: { exec: { command: 'true' } } } }\n`,
  )
  expect(vx('run', '@w/envy#probe').code).toBe(0)
  expect(vx('last', '--log', 'envy#probe').err).toBe(
    noticed('vx last: no recorded run of envy#probe — did you mean @w/envy#probe?\n'),
  )
})
