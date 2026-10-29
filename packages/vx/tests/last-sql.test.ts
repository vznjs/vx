// `vx last --sql <query>`: the local run history as SQL, read-only, so an
// agent filters by task or project, groups and trends over every recorded
// run (durations, cpu, memory, flakiness, the key's inputs) without a
// reader built for each question.
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-sql-' })
  const config = `const cache = { outputs: { files: [] } }
const inputs = { files: ['package.json'] }
export default { tasks: {
  build: { exec: { command: 'echo built' }, inputs, cache },
  bad: { exec: { command: 'exit 3' } },
} }
`
  await addProject(root, 'a', config)
  await addProject(root, 'b', config)
  expect(vx('run', 'build', '--all').code).toBe(0)
  expect(vx('run', 'build', '--all').code).toBe(0)
  expect(vx('run', 'a#bad').code).toBe(1)
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const GROUPED =
  "SELECT project || '#' || task AS taskId, COUNT(*) AS runs, SUM(cache_hit) AS hits FROM runs GROUP BY taskId ORDER BY taskId"

it('--format json prints the rows as objects, grouped as the query says', () => {
  const r = vx('last', '--sql', GROUPED, '--format', 'json')
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(JSON.parse(r.out).rows).toEqual([
    { taskId: 'a#bad', runs: 1, hits: 0 },
    { taskId: 'a#build', runs: 2, hits: 1 },
    { taskId: 'b#build', runs: 2, hits: 1 },
  ])
})

it('pretty prints an aligned table with a header row', () => {
  const r = vx('last', '--sql', GROUPED)
  expect(r.code).toBe(0)
  expect(r.out).toBe(
    ['taskId   runs  hits', 'a#bad    1     0', 'a#build  2     1', 'b#build  2     1', ''].join(
      '\n',
    ),
  )
})

it('joins runs to their invocation: a trend by day and verdict', () => {
  const r = vx(
    'last',
    '--sql',
    "SELECT date(i.started_at / 1000, 'unixepoch') AS day, i.exit_ok AS ok, COUNT(DISTINCT i.run_id) AS n FROM invocations i JOIN runs r ON r.run_id = i.run_id GROUP BY day, ok ORDER BY ok",
    '--format=json',
  )
  expect(r.code).toBe(0)
  const { rows } = JSON.parse(r.out) as { rows: Array<{ day: string; ok: number; n: number }> }
  expect(rows.map(({ ok, n }) => ({ ok, n }))).toEqual([
    { ok: 0, n: 1 },
    { ok: 1, n: 2 },
  ])
})

it('the schema is a query too', () => {
  const r = vx(
    'last',
    '--sql',
    "SELECT name FROM sqlite_schema WHERE name = 'runs'",
    '--format',
    'json',
  )
  expect(JSON.parse(r.out)).toEqual({ rows: [{ name: 'runs' }] })
})

it('a query that writes is refused and the history is left as it was', () => {
  const db = path.join(root, '.vx', 'cache', 'cache.db')
  const before = readFileSync(db)
  for (const sql of [
    'DELETE FROM runs',
    'WITH x AS (SELECT 1) DELETE FROM runs',
    "ATTACH 'x.db' AS x",
    'PRAGMA user_version = 3',
  ]) {
    const r = vx('last', '--sql', sql)
    expect(r.code).toBe(1)
    expect(r.err).toContain('--sql reads only')
  }
  expect(readFileSync(db).equals(before)).toBe(true)
  expect(
    JSON.parse(vx('last', '--sql', 'SELECT COUNT(*) AS n FROM runs', '--format', 'json').out),
  ).toEqual({ rows: [{ n: 5 }] })
})

it('a query SQLite cannot run is refused with its reason', () => {
  const r = vx('last', '--sql', 'SELECT nope FROM runs')
  expect(r.code).toBe(1)
  expect(r.err).toContain('no such column: nope')
})

it('--sql needs a query and combines with nothing but --format and --cache-dir', () => {
  expect(vx('last', '--sql').err).toContain('--sql requires a query')
  for (const extra of [['--list'], ['--failed'], ['--stats'], ['--log', 'a#build'], ['abc12345']]) {
    const r = vx('last', '--sql', 'SELECT 1', ...extra)
    expect(r.code).toBe(1)
    expect(r.err).toContain('--sql combines only with --format and --cache-dir')
  }
})

// A join's `SELECT *` names `run_id` and `started_at` twice: the rows were
// keyed by name, so a table printed one column of each, holding the
// invocation's `started_at` under the task's place in the header.
it('pretty prints a column named twice twice, each with its own value', () => {
  const r = vx('last', '--sql', 'SELECT 1 AS a, 2 AS a, 3 AS b')
  expect([r.code, r.err, r.out]).toEqual([0, '', 'a  a  b\n1  2  3\n'])
})

it('--format json refuses a column named twice, naming it', () => {
  const r = vx('last', '--sql', 'SELECT 1 AS a, 2 AS a, 3 AS b', '--format', 'json')
  expect(r.code).toBe(1)
  expect(JSON.parse(r.out).error.message).toBe(
    'vx last: --sql: column "a" is named twice, and a JSON row holds one value per name; name each with AS',
  )
})

// SQLite prepares the first statement of a text, and the rest was dropped
// without a word: two counts asked, one printed.
it('a second statement is refused, not dropped', () => {
  const r = vx('last', '--sql', 'SELECT 1 AS a; SELECT 2 AS b')
  expect([r.code, r.out]).toEqual([1, ''])
  expect(r.err).toContain(
    '--sql takes one statement, and "SELECT 2 AS b" follows the first: run each in its own --sql',
  )
  // A closing `;` or comment is no second statement (control).
  const ok = vx('last', '--sql', "SELECT 'a;b' AS a; -- the end\n", '--format', 'json')
  expect([ok.code, ok.err, ok.out]).toEqual([0, '', '{"rows":[{"a":"a;b"}]}\n'])
})
