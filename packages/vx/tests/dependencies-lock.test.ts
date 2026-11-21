// `.vx/dependencies.lock.json` is flat: each directory once, sorted, every
// edge and digest an index into that list, so the same workspace writes
// the same bytes and a parse builds few strings. One `graph` array holds
// each project's directory with its digests, then its edges: the parse
// comes first, then the size.

import { expect, it } from 'bun:test'
import {
  dependantsOf,
  dependenciesLock,
  parseDependenciesLock,
  recordedDigests,
} from '../src/workspace/dependencies-lock.js'
import type { ProjectMeta } from '../src/workspace/index.js'

const root = '/ws'
const meta = (name: string, dir: string, deps?: string[], reach?: string[]): ProjectMeta =>
  ({
    name,
    dir: `${root}/${dir}`,
    configPath: null,
    ...(deps ? { deps } : {}),
    ...(reach ? { reach } : {}),
  }) as ProjectMeta

const metas = [
  meta('web', 'apps/web', ['ui', 'core']),
  meta('ui', 'packages/ui', ['core']),
  meta('core', 'packages/core'),
  meta('docs', 'apps/docs', undefined, ['ui']),
]
const files = new Map([['bun.lock', { hash: 'h1', projects: { web: 'dw', ui: 'du', core: 'dc' } }]])

it('writes one graph: each directory with its digests, then its deps, then its reach negated', () => {
  expect(dependenciesLock(root, metas, files)).toEqual({
    version: 4,
    graph: ['apps/docs', -4, 'apps/web,dw', 2, 3, 'packages/core,dc', 'packages/ui,du', 2],
    files: ['bun.lock', 'h1'],
  })
})

it('drops only trailing empty digest slots', () => {
  const two = new Map([
    ['a.lock', { hash: 'ha', projects: { web: 'aw' } }],
    ['b.lock', { hash: 'hb', projects: { web: 'bw', ui: 'bu' } }],
  ])
  const lock = dependenciesLock(root, metas, two)
  expect(lock.graph.filter((v) => typeof v === 'string')).toEqual([
    'apps/docs',
    'apps/web,aw,bw',
    'packages/core',
    'packages/ui,,bu',
  ])
  const read = parseDependenciesLock(new TextEncoder().encode(JSON.stringify(lock)))!
  const a = recordedDigests(read, 'a.lock')!
  const b = recordedDigests(read, 'b.lock')!
  expect([a.of('apps/web'), a.of('packages/ui'), b.of('packages/ui'), b.of('apps/docs')]).toEqual([
    'aw',
    undefined,
    'bu',
    undefined,
  ])
})

// A comma is legal in a directory name: such a row keeps every slot, so it
// holds more commas than there are files and the directory ends at the
// last ones.
it('reads back a directory with a comma in it', () => {
  const odd = [meta('x', 'a,b', ['y']), meta('y', 'c,d')]
  const two = new Map([
    ['a.lock', { hash: 'ha', projects: { x: 'ax' } }],
    ['b.lock', { hash: 'hb', projects: {} }],
  ])
  const lock = dependenciesLock(root, odd, two)
  expect(lock.graph).toEqual(['a,b,ax,', 1, 'c,d,,'])
  const read = parseDependenciesLock(new TextEncoder().encode(JSON.stringify(lock)))!
  expect(dependantsOf(read, 'c,d')).toEqual(['a,b'])
  const a = recordedDigests(read, 'a.lock')!
  expect([
    a.has('a,b'),
    a.of('a,b'),
    a.of('c,d'),
    recordedDigests(read, 'b.lock')!.of('a,b'),
  ]).toEqual([true, 'ax', undefined, undefined])
  const none = dependenciesLock(root, odd, new Map())
  expect(none.graph).toEqual(['a,b', 1, 'c,d'])
  expect(
    dependantsOf(parseDependenciesLock(new TextEncoder().encode(JSON.stringify(none)))!, 'c,d'),
  ).toEqual(['a,b'])
})

it('refuses a digest it could not read back', () => {
  const bad = new Map([['bun.lock', { hash: 'h', projects: { web: 'a,b' } }]])
  expect(() => dependenciesLock(root, metas, bad)).toThrow(
    'bun.lock: the digest for apps/web holds a comma',
  )
})

it('records the other files the digests read, sorted, and only when there are any', () => {
  const withExtras = new Map([
    ['bun.lock', { hash: 'h1', projects: {}, extras: { 'patches/b.patch': 'hb', 'a/x': 'ha' } }],
  ])
  const lock = dependenciesLock(root, metas, withExtras)
  expect(JSON.stringify(lock.extras)).toBe('{"bun.lock":{"a/x":"ha","patches/b.patch":"hb"}}')
  expect(recordedDigests(lock, 'bun.lock')!.extras).toEqual({
    'a/x': 'ha',
    'patches/b.patch': 'hb',
  })
  const plain = dependenciesLock(root, metas, files)
  expect(plain.extras).toBeUndefined()
  expect(recordedDigests(plain, 'bun.lock')!.extras).toEqual({})
})

it('the same projects in another order write the same lock', () => {
  expect(dependenciesLock(root, [...metas].reverse(), files)).toEqual(
    dependenciesLock(root, metas, files),
  )
})

it('reads back what it wrote: dependants by edge or reach, digests by directory', () => {
  const lock = parseDependenciesLock(
    new TextEncoder().encode(JSON.stringify(dependenciesLock(root, metas, files))),
  )!
  expect(dependantsOf(lock, 'packages/ui')).toEqual(['apps/docs', 'apps/web'])
  expect(dependantsOf(lock, 'packages/gone')).toEqual([])
  const rec = recordedDigests(lock, 'bun.lock')!
  expect([rec.hash, rec.of('packages/ui'), rec.of('apps/docs'), rec.of('x')]).toEqual([
    'h1',
    'du',
    undefined,
    undefined,
  ])
  // A project the lock has with no digest, and one it does not have.
  expect([rec.has('apps/docs'), rec.has('x')]).toEqual([true, false])
  expect(recordedDigests(lock, 'pnpm-lock.yaml')).toBeUndefined()
  expect(recordedDigests(lock, 'h1')).toBeUndefined()
})

it('reads nothing from a missing file, another version or another shape', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  expect(parseDependenciesLock(null)).toBeNull()
  expect(parseDependenciesLock(enc({ version: 1, projects: {}, files: {} }))).toBeNull()
  expect(
    parseDependenciesLock(enc({ version: 3, projects: ['a'], deps: [[]], reach: [[]], files: {} })),
  ).toBeNull()
  expect(parseDependenciesLock(new TextEncoder().encode('{'))).toBeNull()
})

it('refuses a lock a newer vx wrote: re-locking would write the older version over it', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 99 }))
  expect(() => parseDependenciesLock(bytes)).toThrow(
    '.vx/dependencies.lock.json was written by a newer vx (version 99; this vx reads 4) — upgrade vx',
  )
})

// A committed file a merge or a hand edit can break inside: a shape check
// of the top level alone let a bad entry through, and the first lookup
// threw a raw TypeError instead of the "invalid, run `vx lock`" refusal.
it('reads nothing from a lock whose entries are not this shape', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const good = { version: 4, graph: ['a,d', 'b', 0, 'c', -1, 1], files: ['bun.lock', 'h'] }
  expect(parseDependenciesLock(enc(good))).not.toBeNull()
  for (const bad of [
    { graph: {} },
    { graph: [0, 'a'] },
    { graph: ['a', 3] },
    { graph: ['a', -2] },
    { graph: ['a', 0.5] },
    { graph: ['a', '0', null] },
    { graph: ['a', ''] },
    { graph: [',d'] },
    { files: {} },
    { files: ['bun.lock'] },
    { files: ['bun.lock', 5] },
    { extras: [] },
    { extras: { 'bun.lock': [] } },
    { extras: { 'bun.lock': { x: 1 } } },
  ]) {
    expect([bad, parseDependenciesLock(enc({ ...good, ...bad }))]).toEqual([bad, null])
  }
  expect(parseDependenciesLock(enc({ ...good, extras: { 'bun.lock': { x: 'h' } } }))).not.toBeNull()
})
