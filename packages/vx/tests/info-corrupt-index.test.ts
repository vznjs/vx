// `vx info` is where a broken setup is diagnosed, so an index SQLite cannot
// read is one of its facts, with the fix, never a refusal of the report.
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'
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
  root = await makeWorkspace({ prefix: 'vx-info-corrupt-' })
  await addProject(
    root,
    'a',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  expect(vx('run', 'a#build').code).toBe(0)
  const db = path.join(root, '.vx', 'cache', 'cache.db')
  await rm(`${db}-wal`, { force: true })
  await rm(`${db}-shm`, { force: true })
  await writeFile(db, 'not a database')
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a cache index SQLite cannot read is a fact, not a refusal', () => {
  const r = vx('info', '--format', 'json')
  expect(r.code).toBe(0)
  const facts = JSON.parse(r.out) as Record<string, unknown>
  expect(facts['cacheIndexError']).toContain('is not a database SQLite can read')
  expect({
    projects: facts['projects'],
    tasks: facts['tasks'],
    cacheEntries: facts['cacheEntries'],
    runs24h: facts['runs24h'],
    flakyTasks: facts['flakyTasks'],
  }).toEqual({ projects: 1, tasks: 1, cacheEntries: 0, runs24h: 0, flakyTasks: [] })
})

it('the pretty report names it on the cache entries row, with the fix', () => {
  const r = vx('info')
  expect(r.code).toBe(0)
  expect(r.out).toMatch(
    /^ {2}cache entries +unreadable: the cache index .* is not a database SQLite can read .*vx cache clean/m,
  )
})

// The open passes and the entry count reads; the page under the flaky
// record, or under the artifacts the orphan scan reads, is the damaged one.
for (const table of ['task_outcomes', 'artifacts']) {
  it(`a damaged ${table} page, read after the open, is the same fact`, async () => {
    const ws = await makeWorkspace({ prefix: 'vx-info-corrupt-page-' })
    const home = path.join(ws, 'home')
    const run = (...args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, BIN, ...args],
        cwd: ws,
        env: { ...process.env, NO_COLOR: '1', HOME: home },
      })
    try {
      await addProject(
        ws,
        'a',
        `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
      )
      expect(run('run', 'a#build').exitCode).toBe(0)
      const files = [path.join(ws, '.vx', 'cache', 'cache.db')]
      for (const f of new Bun.Glob('.vx/*/cache/store.db').scanSync({ cwd: home, dot: true }))
        files.push(path.join(home, f))
      let hit = 0
      for (const file of files.filter((f) => existsSync(f))) {
        const d = new Database(file)
        d.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const { page_size } = d.query('PRAGMA page_size').get() as { page_size: number }
        const row = d.query('SELECT rootpage FROM sqlite_master WHERE name = ?').get(table) as {
          rootpage: number
        } | null
        d.close()
        if (row === null) continue
        hit++
        const fd = openSync(file, 'r+')
        writeSync(fd, Buffer.alloc(page_size, 0xab), 0, page_size, (row.rootpage - 1) * page_size)
        closeSync(fd)
      }
      expect(hit).toBeGreaterThan(0)
      const r = run('info', '--format', 'json')
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
      const facts = JSON.parse(r.stdout.toString()) as Record<string, unknown>
      expect(facts['cacheIndexError']).toContain('database disk image is malformed')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }, 30_000)
}
