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
  const config = `const outputs = { files: [] }
const inputs = { files: ['package.json'] }
export default { tasks: {
  build: { exec: { command: 'echo built' }, inputs, outputs, cache: true },
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
    [
      '  taskId   runs  hits',
      '  a#bad    1     0',
      '  a#build  2     1',
      '  b#build  2     1',
      '',
    ].join('\n'),
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
    'DELETE FROM main.runs',
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
  // The next flag was read as the query, then blamed for combining with it.
  for (const flag of ['--format', '--list']) {
    const r = vx('last', '--sql', flag, 'json')
    expect(r.code).toBe(1)
    expect(r.err).toContain(`--sql requires a query, like 'SELECT * FROM runs' (got flag ${flag}`)
  }
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
  expect([r.code, r.err, r.out]).toEqual([0, '', '  a  a  b\n  1  2  3\n'])
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

// A query whose rows never end (a recursive CTE with no stop) held every row
// in memory, 160 MB in 3 s, until the machine ran out: no word, no end.
// JSON streams each row as SQLite yields it, so it ends when its reader
// does; the table needs every row for its widths, so it is bounded.
const ENDLESS = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c'

it('--format json streams an endless query until its reader closes the pipe', () => {
  const p = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      '"$0" "$1" last --sql "$2" --format json 2>"$3" | head -c 100000 >/dev/null; echo "${PIPESTATUS[0]}"',
      process.execPath,
      BIN,
      ENDLESS,
      path.join(root, 'sql-err.txt'),
    ],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 25_000,
  })
  // Exited on its own, with its own verdict and no word: the reader left.
  expect(p.signalCode ?? null).toBeNull()
  expect(p.stdout.toString().trim()).toBe('0')
  expect(readFileSync(path.join(root, 'sql-err.txt'), 'utf8')).toBe('')
}, 30_000)

it('--format json prints every row of a large result, in order', () => {
  const r = vx('last', '--sql', `${ENDLESS} LIMIT 250000`, '--format', 'json')
  expect([r.code, r.err]).toEqual([0, ''])
  const rows = (JSON.parse(r.out) as { rows: Array<{ x: number }> }).rows
  expect([rows.length, rows[0], rows.at(-1)]).toEqual([250000, { x: 1 }, { x: 250000 }])
}, 30_000)

// Failing after rows went out, the refusal's one-line document was glued
// to the cut stream: neither line a reader could take.
it('--format json puts a refusal after streamed rows on its own last line', () => {
  const r = vx(
    'last',
    '--sql',
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000) SELECT CASE WHEN x > 50000 THEN abs(-9223372036854775808) ELSE x END AS v FROM c',
    '--format',
    'json',
  )
  expect(r.code).toBe(1)
  expect(r.out.startsWith('{"rows":[')).toBe(true)
  const last = r.out.trimEnd().split('\n').at(-1)!
  expect(JSON.parse(last)).toMatchObject({
    ok: false,
    error: { message: 'vx last: --sql: integer overflow' },
  })
}, 30_000)

it('the table refuses a query past its row bound, naming the bound and the stream', () => {
  const r = vx('last', '--sql', ENDLESS)
  expect([r.code, r.out]).toEqual([1, ''])
  expect(r.err).toContain(
    '--sql: the table holds at most 100000 rows, since its column widths need every row first — add a LIMIT, or use --format json, which streams',
  )
  // At the bound exactly, every row prints (control).
  const at = vx('last', '--sql', `${ENDLESS} LIMIT 100000`)
  expect(at.code).toBe(0)
  expect(at.out.trimEnd().split('\n').length).toBe(100001)
}, 30_000)

// A query that matched nothing printed nothing and exited 0: no table, no
// word, the same as a vx that did not run the query at all.
it('a query that selects no row says so', () => {
  const r = vx('last', '--sql', "SELECT run_id FROM runs WHERE task = 'nope'")
  expect([r.code, r.out]).toEqual([0, ''])
  expect(r.err).toContain('vx last  the query selected no rows')
  // JSON's empty `rows` says it already (control).
  const j = vx('last', '--sql', "SELECT run_id FROM runs WHERE task = 'nope'", '--format', 'json')
  expect([j.code, j.out, j.err]).toEqual([0, '{"rows":[]}\n', ''])
})

// A leading comment hid the SELECT from the read-only check: a query that
// reads was refused as a write.
it('a query that opens with a comment reads', () => {
  for (const sql of [
    '/* why */ SELECT 1 AS a',
    '-- why\nSELECT 1 AS a',
    ' /* a */ -- b\n WITH t AS (SELECT 1 AS a) SELECT a FROM t',
  ]) {
    const r = vx('last', `--sql=${sql}`, '--format', 'json')
    expect([r.code, r.err, r.out]).toEqual([0, '', '{"rows":[{"a":1}]}\n'])
  }
  const w = vx('last', '--sql=/* x */ DELETE FROM runs')
  expect(w.code).toBe(1)
  expect(w.err).toContain('--sql reads only')
})

// Nothing binds a parameter: `?` read NULL, and its expansion in the
// statement's text hid a second statement, which was dropped unread.
it('a query with a parameter is refused', () => {
  for (const sql of ['SELECT ? AS a; SELECT 2 AS b', 'SELECT :x AS a']) {
    const r = vx('last', '--sql', sql)
    expect([r.code, r.out]).toEqual([1, ''])
    expect(r.err).toContain('--sql takes no parameters (?, :name)')
  }
  // A `?` in a string is no parameter (control).
  const ok = vx('last', '--sql', "SELECT '?' AS a", '--format', 'json')
  expect([ok.code, ok.out]).toEqual([0, '{"rows":[{"a":"?"}]}\n'])
})

// As doubles, `9007199254740993` printed `…992` in both formats, and a
// BLOB went out as `{"0":10,"1":255}`.
it('keeps an integer past 2^53 whole, and prints a BLOB as its hex', () => {
  const q = "SELECT 9007199254740993 AS big, -9007199254740993 AS neg, 7 AS small, x'0aff' AS b"
  const json = vx('last', '--sql', q, '--format', 'json')
  expect(json.code).toBe(0)
  expect(json.out).toBe(
    '{"rows":[{"big":9007199254740993,"neg":-9007199254740993,"small":7,"b":"0AFF"}]}\n',
  )
  const table = vx('last', '--sql', q)
  expect(table.code).toBe(0)
  expect(table.out).toContain('9007199254740993  -9007199254740993')
})
