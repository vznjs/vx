// `vx info` is where a broken setup is diagnosed, so an index SQLite cannot
// read is one of its facts, with the fix, never a refusal of the report.
import { rm, writeFile } from 'node:fs/promises'
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
