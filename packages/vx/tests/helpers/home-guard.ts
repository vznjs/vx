// A test never writes the real home's shared store (`~/.vx/<repo>`): one
// that does leaves a store per fixture repo on the developer's disk (457 MB
// on one host, 2026-10-21). Fails the process that added one.
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'bun:test'

const store = path.join(homedir(), '.vx')
const list = (): Set<string> => {
  try {
    return new Set(readdirSync(store))
  } catch {
    return new Set()
  }
}
const before = list()

afterAll(() => {
  const added = [...list()].filter((d) => !before.has(d))
  if (added.length > 0)
    throw new Error(
      `a test wrote the real home's shared store: ${added.map((d) => path.join(store, d)).join(', ')}; ` +
        'keep VX_CACHE_DIR in a spawned vx env, or set HOME to a temp dir',
    )
})
