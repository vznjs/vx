// A test never writes the real home's shared store (`~/.vx/<repo>`): one
// that does leaves a store per fixture repo on the developer's disk (457 MB
// on one host, 2026-10-21). Fails the process that added one. The store of
// this repository is not a fixture's: the vx running the suite writes it, as
// a DTE worker does while its other tasks finish beside this one. A sandboxed
// shard cannot read `.git` to name it, so a store holding only this
// repository's projects is taken as its own; an empty one is a few KB.
import { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'bun:test'
import { repoIdOf } from '../../src/workspace/repo-id.js'

const store = path.join(homedir(), '.vx')
const list = (): Set<string> => {
  try {
    return new Set(readdirSync(store))
  } catch {
    return new Set()
  }
}
const before = list()

const own = repoIdOf(path.resolve(import.meta.dir, '../../../..'))

/** Whether the store holds an entry of a project that is not this repository's. */
function holdsForeign(dir: string): boolean {
  let db: Database | undefined
  try {
    db = new Database(path.join(store, dir, 'cache', 'store.db'), { readonly: true })
    return db.query("SELECT 1 FROM entries WHERE project NOT LIKE '@vzn/%' LIMIT 1").get() !== null
  } catch {
    // No database (yet), or no entries table: nothing saved in it.
    return false
  } finally {
    db?.close()
  }
}

afterAll(async () => {
  const ours = await own
  const added = [...list()].filter((d) => !before.has(d) && d !== ours && holdsForeign(d))
  if (added.length > 0)
    throw new Error(
      `a test wrote the real home's shared store: ${added.map((d) => path.join(store, d)).join(', ')}; ` +
        'keep VX_CACHE_DIR in a spawned vx env, or set HOME to a temp dir',
    )
})
