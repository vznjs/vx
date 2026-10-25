// The Bun server: one SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hashPart, oidcAuth } from '@vzn/vx-devtools'
import { sqliteDb } from '../src/bun.js'
import { createHistoryServer } from '../src/server.js'
import { sqliteStore } from '../src/store.js'
import { conformance, scopeOf } from './conformance.js'
import { type Issuer, issuer, trustOf } from './issuer.js'

const MAIN = scopeOf('refs/heads/main')
let server: Bun.Server<undefined>
let iss: Issuer
const dir = mkdtempSync(path.join(tmpdir(), 'vx-history-server-'))

beforeAll(async () => {
  iss = await issuer()
  const handle = createHistoryServer({
    store: sqliteStore(sqliteDb(path.join(dir, 'db.sqlite'))),
    authorize: oidcAuth({ trust: trustOf(), fetchJson: iss.fetchJson }),
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
})

it('folds a thousand tasks in one statement, and sweeps what was not reported', async () => {
  const store = sqliteStore(sqliteDb(path.join(dir, 'sweep.sqlite')))
  await store.init()
  const reports = Array.from({ length: 1000 }, (_, i) => ({ hash: `t${i}`, durationMs: i }))
  const repo = { issuer: 'i', id: '42' }
  await store.fold(repo, MAIN, 1, reports)
  // The same numbers a day later: written again only for the sweep's sake.
  await store.fold(repo, MAIN, 5, reports.slice(0, 10))
  await store.fold(repo, MAIN, 86_400_001, reports.slice(0, 10))
  const other = { issuer: 'j', id: '42' }
  expect((await store.read(other, [MAIN], ['t999'])).size).toBe(0)
  expect((await store.read(repo, [MAIN], ['t999'])).get('t999')).toEqual({
    durationMs: 999,
    cores: null,
    rssBytes: null,
    runs: 1,
  })
  expect(await store.sweep(5)).toBe(990)
})

it('stores the issuer, repository id and scope hashed, never plain', async () => {
  const file = path.join(dir, 'hashed.sqlite')
  const db = sqliteDb(file)
  const store = sqliteStore(db)
  await store.init()
  const repo = { issuer: 'token.actions.githubusercontent.com', id: '42' }
  await store.fold(repo, MAIN, 1, [{ hash: 't', durationMs: 5 }])
  const rows = await db.all<Record<string, unknown>>('SELECT * FROM task_timings', [])
  expect(rows.map(({ issuer, repo_id, scope }) => [issuer, repo_id, scope])).toEqual([
    [await hashPart(repo.issuer), await hashPart('42'), MAIN],
  ])
  expect(JSON.stringify(rows)).not.toMatch(/githubusercontent|refs\/heads|"42"/)
  expect(
    (await store.read(repo, [scopeOf('refs/heads/a'), MAIN], ['t'])).get('t')?.durationMs,
  ).toBe(5)
})
