// The Bun server: one SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { oidcTokenAuth } from '@vzn/vx-devtools'
import { sqliteDb } from '../src/bun.js'
import { timingDaysOf } from '../src/days.js'
import { createHistoryServer } from '../src/server.js'
import { sqliteStore } from '../src/store.js'
import { conformance } from './conformance.js'
import { allowOf, allowVarOf, GITHUB, type Issuer, issuer, REPO } from './issuer.js'

let server: Bun.Server<undefined>
let iss: Issuer
const dir = mkdtempSync(path.join(tmpdir(), 'vx-history-server-'))

beforeAll(async () => {
  iss = await issuer()
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'db.sqlite'))),
    authorize: oidcTokenAuth({ allow: allowOf(), fetchJson: iss.fetchJson }),
  })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
})

afterAll(async () => {
  await server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

conformance('Bun with SQLite', {
  base: () => server.url.href,
  sign: (job) => iss.sign(job, server.url.origin),
  issuer: GITHUB,
  repository: REPO,
})

it('folds a thousand tasks in one statement, and sweeps what was not reported', async () => {
  const store = sqliteStore(sqliteDb(path.join(dir, 'sweep.sqlite')))
  await store.init()
  const reports = Array.from({ length: 1000 }, (_, i) => ({ hash: `t${i}`, durationMs: i }))
  const repo = { issuer: 'i', repository: '42' }
  const main = 'refs/heads/main'
  await store.fold(repo, main, 1, reports)
  // The same numbers a day later: written again only for the sweep's sake.
  await store.fold(repo, main, 5, reports.slice(0, 10))
  await store.fold(repo, main, 86_400_001, reports.slice(0, 10))
  const other = { issuer: 'j', repository: '42' }
  expect((await store.read(other, [main], ['t999'])).size).toBe(0)
  expect((await store.read(repo, [main], ['t999'])).get('t999')).toEqual({
    durationMs: 999,
    cores: null,
    rssBytes: null,
    runs: 1,
  })
  // A row is kept a day past its last write: a report it skipped may be that recent.
  expect(await store.sweep(86_400_005, 86_400_006)).toBe(990)
  expect(await store.sweptAt()).toBe(86_400_006)
})

// A report that does not move its row is not written for up to a day, so
// the row's write time lags its last report: the sweep deleted a task
// reported hours before, every row of a TIMING_DAYS=1 server.
it('keeps a row reported within TIMING_DAYS, though that report was not written', async () => {
  const day = 86_400_000
  let t = 10 * day
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'lag.sqlite'))),
    authorize: async () => ({ issuer: GITHUB, repository: REPO, write: 'refs/heads/main' }),
    timingDays: 1,
    now: () => t,
  })
  const post = (route: string, body: unknown) =>
    handle(
      new Request(`http://127.0.0.1/v1/timings/${route}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    )
  await post('upload', { timings: [{ hash: 'kept', durationMs: 100 }] })
  t += 0.9 * day
  // The same numbers: no write, the row's time stays.
  await post('upload', { timings: [{ hash: 'kept', durationMs: 100 }] })
  t += 0.2 * day
  // Another task's upload: the day's sweep.
  await post('upload', { timings: [{ hash: 'other', durationMs: 5 }] })
  const res = await post('query', {
    issuer: GITHUB,
    repository: REPO,
    refs: ['refs/heads/main'],
    hashes: ['kept'],
  })
  expect(((await res.json()) as { timings: object }).timings).toEqual({
    kept: { durationMs: 100, cores: null, rssBytes: null, runs: 1 },
  })
})

it("folds and reads within D1's 2 MB a bound string may be", async () => {
  const sqlite = sqliteDb(path.join(dir, 'd1-limits.sqlite'))
  // D1's limit (developers.cloudflare.com/d1/platform/limits): a string past it fails the statement.
  const within = (params: readonly unknown[]) => {
    for (const p of params)
      if (typeof p === 'string' && Buffer.byteLength(p) > 2_000_000)
        throw new Error('SQLITE_TOOBIG')
  }
  const store = sqliteStore({
    all: (sql, params) => (within(params), sqlite.all(sql, params)),
    run: (sql, params) => (within(params), sqlite.run(sql, params)),
  })
  await store.init()
  const reports = Array.from({ length: 10_000 }, (_, i) => ({
    hash: `${i}`.padStart(512, 'h'),
    durationMs: i,
  }))
  const repo = { issuer: 'i', repository: 'acme/app' }
  await store.fold(repo, 'refs/heads/main', 1, reports)
  const got = await store.read(
    repo,
    ['refs/heads/main'],
    reports.map((r) => r.hash),
  )
  expect([got.size, got.get(reports[9_999]!.hash)?.durationMs]).toEqual([10_000, 9_999])
})

// 2026-10-27: rows held hashes of these, which only hid them from whoever runs the server.
it('stores the issuer, repository and ref plainly, as a person reading the table would ask', async () => {
  const db = sqliteDb(path.join(dir, 'plain.sqlite'))
  const store = sqliteStore(db)
  await store.init()
  await store.fold({ issuer: GITHUB, repository: 'vznjs/vx' }, 'refs/heads/main', 1, [
    { hash: 't', durationMs: 5 },
  ])
  const rows = await db.all<Record<string, unknown>>(
    'SELECT issuer, repository, ref, hash, duration_ms FROM timings',
    [],
  )
  expect(rows).toEqual([
    { issuer: GITHUB, repository: 'vznjs/vx', ref: 'refs/heads/main', hash: 't', duration_ms: 5 },
  ])
})

it('drops the table rows were keyed by four columns in', async () => {
  const db = sqliteDb(path.join(dir, 'old.sqlite'))
  await db.run('CREATE TABLE task_timings (issuer TEXT)', [])
  await sqliteStore(db).init()
  expect(
    await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'", []),
  ).toEqual([{ name: 'timings' }, { name: 'sweeps' }])
})

it('answers an upload it folded even when the sweep after it fails, and sweeps on the next', async () => {
  const store = sqliteStore(sqliteDb(path.join(dir, 'sweep-fails.sqlite')))
  let sweeps = 0
  const errors: unknown[] = []
  const logged = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  const handle = createHistoryServer({
    store: {
      ...store,
      sweep: async (before, now) => {
        if (++sweeps === 1) throw new Error('the database is busy')
        return store.sweep(before, now)
      },
    },
    authorize: oidcTokenAuth({ allow: allowOf(), fetchJson: iss.fetchJson }),
  })
  const upload = async () =>
    handle(
      new Request('http://127.0.0.1/v1/timings/upload', {
        method: 'POST',
        body: JSON.stringify({ timings: [{ hash: 't', durationMs: 5 }] }),
        headers: {
          authorization: `Bearer ${await iss.sign('main', 'http://127.0.0.1')}`,
          'content-type': 'application/json',
        },
      }),
    )
  try {
    expect((await upload()).status).toBe(204)
    expect((await upload()).status).toBe(204)
  } finally {
    console.error = logged
  }
  expect(sweeps).toBe(2)
  expect(errors).toEqual(['vx-history-server: the sweep: Error: the database is busy'])
})

// The client warns with what the server says: "internal error" told an
// operator reading the warning nothing (2026-10-28).
it('answers a failure it did not expect with what failed, and logs it', async () => {
  const errors: unknown[] = []
  const logged = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  const handle = createHistoryServer({
    store: {
      ...sqliteStore(sqliteDb(path.join(dir, 'busy.sqlite'))),
      read: async () => {
        throw new Error('the database is busy')
      },
    },
    authorize: async () => ({ issuer: GITHUB, repository: REPO }),
  })
  let res: Response
  try {
    res = await handle(
      new Request('http://127.0.0.1/v1/timings/query', {
        method: 'POST',
        body: JSON.stringify({
          issuer: GITHUB,
          repository: REPO,
          refs: ['refs/heads/main'],
          hashes: ['t'],
        }),
        headers: { 'content-type': 'application/json' },
      }),
    )
  } finally {
    console.error = logged
  }
  expect([res.status, await res.json(), errors]).toEqual([
    500,
    { code: 'internal_error', message: 'the database is busy' },
    ['vx-history-server: POST /v1/timings/query: Error: the database is busy'],
  ])
})

// Workers run many isolates, each its own node, and start new ones all
// day: each swept on its first upload, a scan of the whole table each time.
it('sweeps once a day across every node that serves the database', async () => {
  const sqlite = sqliteDb(path.join(dir, 'nodes.sqlite'))
  let sweeps = 0
  const db = {
    all: sqlite.all,
    run: (sql: string, params: readonly unknown[]) => {
      if (sql.startsWith('DELETE FROM timings')) sweeps++
      return sqlite.run(sql, params)
    },
  }
  let t = 100 * 86_400_000
  const node = () =>
    createHistoryServer({
      store: sqliteStore(db),
      authorize: async () => ({ issuer: GITHUB, repository: REPO, write: 'refs/heads/main' }),
      now: () => t,
    })
  const upload = (handle: (req: Request) => Promise<Response>) =>
    handle(
      new Request('https://history.example.com/v1/timings/upload', {
        method: 'POST',
        body: JSON.stringify({ timings: [{ hash: 'a', durationMs: 1 }] }),
        headers: { 'content-type': 'application/json' },
      }),
    )
  for (let i = 0; i < 3; i++) expect((await upload(node())).status).toBe(204)
  expect(sweeps).toBe(1)
  t += 86_400_000
  for (let i = 0; i < 3; i++) expect((await upload(node())).status).toBe(204)
  expect(sweeps).toBe(2)
})

// A chunked body names no length: it was read whole, however large,
// before it was measured (2026-10-26).
it('refuses a query body past its limit as it arrives', async () => {
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'large.sqlite'))),
    authorize: async () => ({ issuer: GITHUB, repository: REPO }),
  })
  let pulled = 0
  // 8 MB in all, so a read of the whole body ends, and fails below.
  const large = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulled > 128) return c.close()
      c.enqueue(new Uint8Array(64 * 1024).fill(32))
    },
  })
  const res = await handle(
    new Request('https://history.example.com/v1/timings/query', {
      method: 'POST',
      body: large,
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([
    413,
    'the body is at most 6010000 bytes',
  ])
  expect(pulled).toBeLessThan(100)
})

// A query names its repository in its body, which was read whole before
// the token was looked at: anyone could make the server hold a body open.
it('refuses a query with no token, or a bad one, before reading its body', async () => {
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'early.sqlite'))),
    authorize: oidcTokenAuth({ allow: allowOf(), fetchJson: iss.fetchJson }),
  })
  for (const token of [null, 'not.a.jwt']) {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++pulled > 1) return new Promise<void>(() => {})
        c.enqueue(new TextEncoder().encode('{'))
      },
    })
    const res = await handle(
      new Request('http://127.0.0.1/v1/timings/query', {
        method: 'POST',
        body: endless,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      }),
    )
    expect(res.status).toBe(401)
  }
})

// A 401 tells a client its token is refused; the issuer's keys being out
// of reach is not that (2026-10-26).
it("answers 502 while the issuer's keys cannot be read", async () => {
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'keys.sqlite'))),
    authorize: oidcTokenAuth({
      allow: allowOf(),
      fetchJson: async (url) => {
        throw new Error(`${url}: 503`)
      },
    }),
  })
  const res = await handle(
    new Request('http://127.0.0.1/v1/capabilities', {
      headers: {
        authorization: `Bearer ${await iss.sign('main', 'http://127.0.0.1')}`,
      },
    }),
  )
  expect([res.status, await res.json()]).toEqual([
    502,
    {
      code: 'bad_gateway',
      message: `could not read ${GITHUB}'s keys: ${GITHUB}/.well-known/openid-configuration: 503`,
    },
  ])
})

// A JWKS the issuer serves broken is its fault, not the token's: it was
// answered 401 "not a JWT", which turns a client's remote off for the run.
it("answers 502, saying why, while the issuer's keys are not a key set", async () => {
  const said = async (jwks: unknown) => {
    const handle = createHistoryServer({
      store: sqliteStore(sqliteDb(':memory:')),
      authorize: oidcTokenAuth({
        allow: allowOf(),
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${GITHUB}/keys` } : jwks,
      }),
    })
    const res = await handle(
      new Request('http://127.0.0.1/v1/capabilities', {
        headers: { authorization: `Bearer ${await iss.sign('main', 'http://127.0.0.1')}` },
      }),
    )
    return [res.status, ((await res.json()) as { message: string }).message]
  }
  expect(await said({ keys: 'x' })).toEqual([
    502,
    `could not read ${GITHUB}'s keys: JSON Web Key Set malformed`,
  ])
})

/** What the CLI said on stderr, past the refusal line's mark. */
const stderrOf = (cli: { stderr: Buffer }): string =>
  Bun.stripANSI(cli.stderr.toString()).replace(/^✗ vx-history-server {2}/, '')

// jose matches aud exactly: AUDIENCE with a pasted newline refused every
// token as the wrong audience. The Workers entry trims it
// (worker.test.ts); so does this one. The issuer is on loopback, as the
// image's smoke test serves it, so the spawned server reaches its keys.
it('reads AUDIENCE without the blanks around it', async () => {
  let keysOf: Issuer | undefined
  const keys = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => Response.json(await keysOf!.fetchJson(req.url)),
  })
  const at = await issuer(keys.url.origin)
  keysOf = at
  const cli = Bun.spawn(
    [
      'bun',
      path.join(import.meta.dir, '..', 'src', 'bun.ts'),
      ...['--port', '0', '--host', '127.0.0.1', '--db', ':memory:'],
    ],
    {
      env: {
        ...process.env,
        ALLOW: allowVarOf(at.iss),
        AUDIENCE: ' https://history.example\n',
      },
      stdout: 'pipe',
    },
  )
  try {
    const line = new TextDecoder().decode((await cli.stdout.getReader().read()).value)
    const base = /on (\S+)/.exec(line)![1]!
    const res = await fetch(new URL('/v1/capabilities', base), {
      headers: { authorization: `Bearer ${await at.sign('read', 'https://history.example')}` },
    })
    expect(res.status).toBe(200)
  } finally {
    cli.kill()
    await cli.exited
    await keys.stop(true)
  }
})

// Number() read 0x1e as 30 and 3e1 as 30, as it read --port, which takes
// digits only since c4d2ce089c.
it('reads TIMING_DAYS only as decimal digits', () => {
  for (const v of ['0x1e', '3e1', ' 30', '30 ', '+30'])
    expect(() => timingDaysOf(v)).toThrow(`TIMING_DAYS: a whole number of days, got ${v}`)
  expect([timingDaysOf('30'), timingDaysOf(30), timingDaysOf('')]).toEqual([30, 30, undefined])
})

it('answers a flag it does not know with its usage', () => {
  const cli = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--bogus'], {
    stderr: 'pipe',
  })
  const [said, usage] = stderrOf(cli).split('\n')
  expect([cli.exitCode, said, usage?.split(' ').slice(0, 2).join(' ')]).toEqual([
    2,
    "Unknown option '--bogus'",
    'usage: vx-history-server',
  ])
})

it('names ALLOW when it cannot be read', () => {
  const said = (allow: string) => {
    const cli = Bun.spawnSync(
      ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--port', '0', '--db', ':memory:'],
      { env: { ...process.env, ALLOW: allow }, stderr: 'pipe' },
    )
    return [cli.exitCode, stderrOf(cli)]
  }
  expect([said('acme/app'), said('https://x:acme:ci.yml')]).toEqual([
    [2, 'ALLOW: acme/app is not issuer:owner/repo:workflow\n'],
    [2, 'ALLOW: https://x:acme:ci.yml is not issuer:owner/repo:workflow\n'],
  ])
})

it('refuses to start with ALLOW empty: it would refuse every request', () => {
  for (const allow of [undefined, '', ' ']) {
    const cli = Bun.spawnSync(
      ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--port', '0', '--db', ':memory:'],
      {
        env: { ...process.env, ...(allow === undefined ? {} : { ALLOW: allow }) },
        stderr: 'pipe',
        // Started, it would listen until killed.
        timeout: 10_000,
      },
    )
    const [said, usage] = cli.stderr.toString().split('\n')
    expect([cli.exitCode, said, usage?.split(' ').slice(0, 2).join(' ')]).toEqual([
      2,
      '✗ vx-history-server  set ALLOW',
      'usage: vx-history-server',
    ])
  }
})

// Unset, the audience was the origin the request named, its Host header:
// a token minted for another service was taken by sending its host.
it('refuses to start without AUDIENCE', () => {
  const cli = Bun.spawnSync(
    ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--port', '0', '--db', ':memory:'],
    {
      env: { ...process.env, ALLOW: `${GITHUB}:${REPO}:ci.yml`, AUDIENCE: '' },
      stderr: 'pipe',
      // Started, it would listen until killed.
      timeout: 10_000,
    },
  )
  expect([cli.exitCode, stderrOf(cli).split('\n')[0]]).toEqual([
    2,
    'set AUDIENCE: the aud a CI token names, the URL clients reach this server at',
  ])
})

it('names --db when it cannot be opened, and refuses an empty one', () => {
  const said = (db: string) => {
    const cli = Bun.spawnSync(
      ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--port', '0', '--db', db],
      { env: { ...process.env, ALLOW: `${GITHUB}:${REPO}:ci.yml` }, stderr: 'pipe' },
    )
    return [cli.exitCode, stderrOf(cli).split('\n')[0]]
  }
  expect([said('/proc/no/such/dir/x.db'), said('')]).toEqual([
    [2, '--db /proc/no/such/dir/x.db: unable to open database file'],
    [2, "--db: needs a file path, got ''"],
  ])
})

it('refuses an empty --port: Number of it is 0, a random port', () => {
  const cli = Bun.spawnSync(
    ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--port', '', '--db', ':memory:'],
    { env: { ...process.env, ALLOW: '' }, stderr: 'pipe' },
  )
  expect([cli.exitCode, stderrOf(cli)]).toEqual([2, '--port: not a port: \n'])
})

// Bun.serve reads '' as localhost: `--host "$HOST"` with HOST unset
// listened where no other host or container could reach it.
it('refuses an empty --host', () => {
  const cli = Bun.spawnSync(
    ['bun', path.join(import.meta.dir, '..', 'src', 'bun.ts'), '--host', '', '--db', ':memory:'],
    { env: { ...process.env, ALLOW: '' }, stderr: 'pipe' },
  )
  expect([cli.exitCode, stderrOf(cli)]).toEqual([2, "--host: needs an address, got ''\n"])
})

it('takes --port only as decimal digits: Number read 0x50 as 80 and 1e1 as 10', () => {
  const said = (port: string) => {
    const cli = Bun.spawnSync(
      [
        'bun',
        path.join(import.meta.dir, '..', 'src', 'bun.ts'),
        '--port',
        port,
        '--db',
        ':memory:',
      ],
      {
        env: { ...process.env, ALLOW: '', AUDIENCE: 'https://history.example' },
        stderr: 'pipe',
        timeout: 2000,
      },
    )
    return [cli.exitCode, stderrOf(cli)]
  }
  expect(['0x50', '1e1', ' 80', '80.0'].map(said)).toEqual([
    [2, '--port: not a port: 0x50\n'],
    [2, '--port: not a port: 1e1\n'],
    [2, '--port: not a port:  80\n'],
    [2, '--port: not a port: 80.0\n'],
  ])
}, 20_000)

it('reads with no token where READ_ACCESS is public, only a repository ALLOW names', async () => {
  const auth = oidcTokenAuth({ allow: allowOf(), readAccess: 'public', fetchJson: iss.fetchJson })
  const req = new Request('http://127.0.0.1/v1/timings/query')
  expect(await auth(req, { issuer: `${GITHUB}/`, repository: REPO.toUpperCase() })).toEqual({
    issuer: GITHUB,
    repository: REPO,
  })
  await expect(auth(req, { issuer: GITHUB, repository: 'acme/other' })).rejects.toThrow(
    "acme/other is not in this server's ALLOW",
  )
  expect(await auth(req)).toBeUndefined()
  const closed = oidcTokenAuth({ allow: allowOf(), fetchJson: iss.fetchJson })
  await expect(closed(req, { issuer: GITHUB, repository: REPO })).rejects.toThrow('no bearer token')
})

// The image pinned jose itself (`bun add jose@…`), apart from the version
// @vzn/vx-devtools pins: a bump there left the image on the old one.
it('builds its image with the dependencies package.json pins, naming no version of its own', async () => {
  const dockerfile = await Bun.file(`${import.meta.dir}/../Dockerfile`).text()
  expect(dockerfile).not.toMatch(/bun add/)
  expect(dockerfile).toContain('bun install --production')
})
