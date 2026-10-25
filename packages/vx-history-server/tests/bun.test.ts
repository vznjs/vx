// The Bun server: one SQLite file.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { oidcAuth } from '@vzn/vx-devtools'
import { sqliteDb } from '../src/bun.js'
import { createHistoryServer } from '../src/server.js'
import { sqliteStore } from '../src/store.js'
import { conformance } from './conformance.js'
import { type Issuer, issuer, trustOf } from './issuer.js'

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
  await store.fold(repo, 'refs/heads/main', 1, reports)
  await store.fold(repo, 'refs/heads/main', 5, reports.slice(0, 10))
  const other = { issuer: 'j', id: '42' }
  expect((await store.read(other, ['refs/heads/main'], ['t999'])).size).toBe(0)
  expect((await store.read(repo, ['refs/heads/main'], ['t999'])).get('t999')).toEqual({
    durationMs: 999,
    cores: null,
    rssBytes: null,
    runs: 1,
  })
  expect(await store.sweep(2)).toBe(990)
})
