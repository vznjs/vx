// Warm-ups learned across runs: a CI run writes each size's under its
// commit, and a later commit's run reads it (M, 2026-10-23).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PluginCache } from '@vzn/vx'
import { parseWarmUps, readWarmUps, writeWarmUps } from '../src/warm-ups.js'

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
