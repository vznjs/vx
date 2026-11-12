import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateHeapSnapshot } from 'bun'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Cache } from '../src/cache/index.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-held-sizes-'))
  dir = path.join(root, 'cache')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const open = (): Cache =>
  new Cache(dir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)

function stored(): number {
  const db = new Database(path.join(dir, 'cache.db'), { readonly: true })
  try {
    return (db.query('SELECT count(*) AS n FROM blob_sizes').get() as { n: number }).n
  } finally {
    db.close()
  }
}

const sizes = (n: number): Map<string, number> =>
  new Map(Array.from({ length: n }, (_, i) => [`oid${i}`, i]))

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

it('held blob sizes are stored while the run goes on, not when remembered', async () => {
  const cache = open()
  cache.memo.holdBlobSizes()
  cache.memo.rememberBlobSizes(sizes(600))
  expect(stored()).toBe(0)
  cache.memo.storeHeldBlobSizes()
  expect(stored()).toBe(0)
  await turn()
  expect(stored()).toBeGreaterThan(0)
  expect(stored()).toBeLessThan(600)
  for (let i = 0; i < 5; i++) await turn()
  expect(stored()).toBe(600)
  cache.memo.rememberBlobSizes(sizes(1))
  cache.close()
})

// An entry the test can find in a heap snapshot by its class name.
class HeldSize {
  0: string
  1: number
  constructor(oid: string, size: number) {
    this[0] = oid
    this[1] = size
  }
}

// Whether any `from` object reaches a `to` object by the heap's edges,
// closures' scopes included. A WeakRef count was GC-dependent: the
// collector scans the stack conservatively, and one stale slot naming the
// held array kept all 600 alive on CI (2026-11-06).
function reaches(from: string, to: string): boolean {
  const snap = generateHeapSnapshot() as unknown as {
    nodes: number[]
    nodeClassNames: string[]
    edges: number[]
  }
  const fromClass = snap.nodeClassNames.indexOf(from)
  const toClass = snap.nodeClassNames.indexOf(to)
  if (fromClass < 0 || toClass < 0) return false
  const classOf = new Map<number, number>()
  for (let i = 0; i < snap.nodes.length; i += 4) classOf.set(snap.nodes[i]!, snap.nodes[i + 2]!)
  const out = new Map<number, number[]>()
  for (let i = 0; i < snap.edges.length; i += 4) {
    const list = out.get(snap.edges[i]!)
    if (list === undefined) out.set(snap.edges[i]!, [snap.edges[i + 1]!])
    else list.push(snap.edges[i + 1]!)
  }
  const stack = [...classOf].filter(([, c]) => c === fromClass).map(([id]) => id)
  const seen = new Set<number>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    if (classOf.get(id) === toClass) return true
    for (const next of out.get(id) ?? []) stack.push(next)
  }
  return false
}

it('stored blob sizes are let go, not held to the end of the run', async () => {
  const cache = open()
  cache.memo.holdBlobSizes()
  const entries = function* (): Generator<HeldSize> {
    for (let i = 0; i < 600; i++) yield new HeldSize(`oid${i}`, i)
  }
  cache.memo.rememberBlobSizes({ [Symbol.iterator]: entries } as unknown as Map<string, number>)
  expect(reaches('Cache', 'HeldSize')).toBe(true)
  cache.memo.storeHeldBlobSizes()
  for (let i = 0; i < 6; i++) await turn()
  expect(stored()).toBe(600)
  expect(reaches('Cache', 'HeldSize')).toBe(false)
  cache.close()
})

it('close stores what is still held, stored or not', () => {
  const never = open()
  never.memo.holdBlobSizes()
  never.memo.rememberBlobSizes(sizes(10))
  never.close()
  expect(stored()).toBe(10)
  const mid = open()
  mid.memo.holdBlobSizes()
  mid.memo.rememberBlobSizes(new Map(Array.from({ length: 600 }, (_, i) => [`x${i}`, i])))
  mid.memo.storeHeldBlobSizes()
  mid.close()
  expect(stored()).toBe(610)
  expect(open().memo.knownBlobSizes(['x599'])).toEqual(new Map([['x599', 599]]))
})

it('held blob sizes are stored in OID order, the key index appended at its edge', async () => {
  const cache = open()
  cache.memo.holdBlobSizes()
  // Path order is not OID order: remembered descending.
  cache.memo.rememberBlobSizes(new Map(Array.from({ length: 600 }, (_, i) => [`oid${999 - i}`, i])))
  cache.memo.storeHeldBlobSizes()
  for (let i = 0; i < 5; i++) await turn()
  const db = new Database(path.join(dir, 'cache.db'), { readonly: true })
  try {
    const rows = db.query('SELECT oid FROM blob_sizes ORDER BY rowid').all() as Array<{
      oid: string
    }>
    expect(rows.map((r) => r.oid)).toEqual(Array.from({ length: 600 }, (_, i) => `oid${400 + i}`))
  } finally {
    db.close()
  }
  cache.close()
})

// A JS comparator over a cold run's 40,000 sizes was 32 ms of its main
// thread before the first task; the native string sort is 8 (2026-11-07).
it('held blob sizes are ordered by the native sort, no JS comparator', () => {
  const cache = open()
  cache.memo.holdBlobSizes()
  cache.memo.rememberBlobSizes(new Map(Array.from({ length: 600 }, (_, i) => [`oid${999 - i}`, i])))
  const sorts = [Array.prototype, Object.getPrototypeOf(Uint32Array.prototype)] as Array<{
    sort: (cmp?: unknown) => unknown
  }>
  const saved = sorts.map((p) => p.sort)
  let comparators = 0
  let natives = 0
  sorts.forEach((p, i) => {
    p.sort = function (this: unknown, cmp?: unknown) {
      if (cmp === undefined) natives++
      else comparators++
      return saved[i]!.call(this, cmp)
    }
  })
  try {
    cache.memo.storeHeldBlobSizes()
  } finally {
    sorts.forEach((p, i) => (p.sort = saved[i]!))
  }
  expect({ comparators, natives }).toEqual({ comparators: 0, natives: 1 })
  cache.close()
  expect(open().memo.knownBlobSizes(['oid400', 'oid999'])).toEqual(
    new Map([
      ['oid400', 599],
      ['oid999', 0],
    ]),
  )
})

it('an empty memo answers no size', () => {
  const cache = open()
  expect(cache.memo.knownBlobSizes(['a', 'b'])).toEqual(new Map())
  cache.memo.rememberBlobSizes(new Map([['a', 1]]))
  expect(cache.memo.knownBlobSizes(['a', 'b'])).toEqual(new Map([['a', 1]]))
  cache.close()
})
