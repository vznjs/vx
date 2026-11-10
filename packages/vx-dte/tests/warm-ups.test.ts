// Warm-ups learned across runs: a CI run writes each size's under its
// commit, and a later commit's run reads it (2026-10-23).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PluginCache } from '@vzn/vx'
import {
  parseServerBases,
  parseSizeOthers,
  parseWarmUps,
  readServerBases,
  readWarmUps,
  writeServerBases,
  writeWarmUps,
} from '../src/warm-ups.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-warm-ups-'))
  git('init', '-q')
  commit()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function git(...args: string[]): void {
  const r = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd: root,
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}
const commit = (): void => git('commit', '-q', '--allow-empty', '-m', 'c')

/** A cache of plain entries; `hasMany` null asks `get` one at a time. */
function store(batch = true): PluginCache & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>()
  return {
    entries,
    get: async (k) => entries.get(k) ?? null,
    put: async (k, b) => void (entries.has(k) || entries.set(k, b)),
    has: async (k) => entries.has(k),
    hasMany: async (ks) => (batch ? new Set(ks.filter((k) => entries.has(k))) : null),
    getRun: async () => null,
  }
}

it("a later commit's run plans the warm-ups an earlier commit's run learned", async () => {
  const cache = store()
  await writeWarmUps(cache, root, new Map([['big', 40_000]]), new Map([['small', 14_900.4]]))
  commit()
  commit()
  expect([...(await readWarmUps(cache, root))]).toEqual([
    ['big', 40_000],
    ['small', 14_900],
  ])
  expect([...(await readWarmUps(store(), root))]).toEqual([])
})

it("this run's warm-up of a size replaces the one it read", async () => {
  const cache = store(false)
  await writeWarmUps(cache, root, new Map([['mac', 40_000]]), new Map([['mac', 27_000]]))
  commit()
  expect(await readWarmUps(cache, root)).toEqual(new Map([['mac', 27_000]]))
})

it('a run no worker of its own joined writes nothing', async () => {
  const cache = store()
  await writeWarmUps(cache, root, new Map([['mac', 40_000]]), new Map())
  expect(cache.entries.size).toBe(0)
})

it('reads a malformed blob as none and drops a value out of range', () => {
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v))
  expect(parseWarmUps(new TextEncoder().encode('{'))).toBeNull()
  expect(parseWarmUps(enc({ version: 2, sizes: {} }))).toBeNull()
  expect(parseWarmUps(enc({ version: 1, sizes: [] }))).toBeNull()
  expect(parseWarmUps(enc({ version: 1, sizes: { a: 1, b: -1, c: 'x', d: 4e6 } }))).toEqual(
    new Map([['a', 1]]),
  )
})

it("a later commit's run books the server bases an earlier run learned, this run's over them", async () => {
  const cache = store()
  await writeServerBases(
    cache,
    root,
    new Map([
      ['s#db', 0.5],
      ['s#api', 1],
    ]),
    new Map([['s#api', 0.254]]),
  )
  commit()
  expect(await readServerBases(cache, root)).toEqual(
    new Map([
      ['s#db', 0.5],
      ['s#api', 0.25],
    ]),
  )
  // Nothing fitted this run: nothing written.
  const none = store()
  await writeServerBases(none, root, new Map([['s#db', 0.5]]), new Map())
  expect(none.entries.size).toBe(0)
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v))
  expect(parseServerBases(enc({ version: 1, servers: [] }))).toBeNull()
  expect(parseServerBases(enc({ version: 1, servers: { a: -1, b: 'x', c: 2 } }))).toEqual(
    new Map([['c', 2]]),
  )
})

it("reads each size's other cores as server bases are read", () => {
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v))
  expect(parseSizeOthers(enc({ version: 1, sizes: { small: 0.8, mac: -1, x: 'a' } }))).toEqual(
    new Map([['small', 0.8]]),
  )
  expect(parseSizeOthers(enc({ version: 1, servers: { small: 0.8 } }))).toBeNull()
})
