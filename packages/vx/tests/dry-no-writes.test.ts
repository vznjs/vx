// `--dry` with no remote to probe writes nothing (docs/modules/orchestrator.md,
// "Side effects"). It opened the local cache as a run does: a fresh
// workspace got `.vx/cache/cache.db*` and `.vx/.gitignore`, `--cache-dir
// .vx/cahce` made the typo's directory (item 900 fixed that for the reading
// verbs, not for the plan), and the file-hash memo took rows. A plan with a
// remote keeps the hits it finds for the run after it
// (`orchestrator-remote.test.ts` › "plan then run").
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { planRun as corePlanRun } from '../src/orchestrator/index.js'
import { lock, run } from './helpers/orchestrator.js'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { relPosix } from '../src/util/index.js'

const BUILD = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      },
    },
  }
`

let fixture: Fixture | undefined
afterEach(async () => {
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true })
  fixture = undefined
})

/** Every path under `dir` but `.git`, sorted. */
async function tree(dir: string): Promise<string[]> {
  const all = await readdir(dir, { recursive: true })
  return all
    .map((p) => relPosix(dir, path.join(dir, p)))
    .filter((p) => p !== '.git' && !p.startsWith('.git/'))
    .sort()
}

/** Every row of every table in the index at `db`. */
function rows(db: string): Record<string, unknown[]> {
  const d = new Database(db, { readonly: true })
  try {
    const tables = d
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    return Object.fromEntries(
      tables.map((t) => [t.name, d.query(`SELECT * FROM "${t.name}"`).all()]),
    )
  } finally {
    d.close()
  }
}

async function workspace(): Promise<Fixture> {
  fixture = await makeWorkspace('vx-dry-no-writes-')
  await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: BUILD })
  await lock(fixture.root)
  return fixture
}

describe('--dry writes nothing', () => {
  it(
    'a fresh workspace keeps no cache directory and no .gitignore',
    async () => {
      const f = await workspace()
      const before = await tree(f.root)
      const plan = await corePlanRun({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
      expect(plan.tasks.map((t) => t.cacheStatus)).toEqual(['miss'])
      expect(await tree(f.root)).toEqual(before)
    },
    TIMEOUT,
  )

  it(
    'a --cache-dir that does not exist is not made',
    async () => {
      const f = await workspace()
      const before = await tree(f.root)
      await corePlanRun({
        cwd: f.root,
        tasks: ['build'],
        log: silentLogger(f),
        cacheDir: path.join(f.root, '.vx', 'cahce'),
      })
      expect(await tree(f.root)).toEqual(before)
    },
    TIMEOUT,
  )

  it(
    'a local hit changes no row of the index and no file',
    async () => {
      const f = await workspace()
      expect((await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })).ok).toBe(true)
      const db = path.join(f.root, '.vx', 'cache', 'cache.db')
      const index = rows(db)
      const before = await tree(f.root)
      const plan = await corePlanRun({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
      expect(plan.tasks.map((t) => t.cacheStatus)).toEqual(['hit-local'])
      expect(rows(db)).toEqual(index)
      expect(await tree(f.root)).toEqual(before)
    },
    TIMEOUT,
  )

  it(
    'an index of another schema is read as the empty one the run would reset it to, and left as it is',
    async () => {
      const f = await workspace()
      expect((await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })).ok).toBe(true)
      const db = path.join(f.root, '.vx', 'cache', 'cache.db')
      const old = new Database(db)
      old.exec("UPDATE schema_meta SET value = 'v1' WHERE key = 'version'")
      old.close()
      const index = rows(db)
      const plan = await corePlanRun({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
      expect(plan.tasks.map((t) => t.cacheStatus)).toEqual(['miss'])
      expect(rows(db)).toEqual(index)
    },
    TIMEOUT,
  )
})
