// `.vx/dependencies.lock.json` is flat: each directory once, sorted, every
// edge and digest an index into that list, so the same workspace writes
// the same bytes and a parse builds few strings. `deps` and `reach` list
// only the projects with edges, as `project, count, ...targets` runs, and
// are left out when no project has any: most entries are empty, and one
// flat number array parses faster than an array per project.

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

it('writes each directory once, sorted, and every edge and digest as a sorted index', () => {
  expect(dependenciesLock(root, metas, files)).toEqual({
    version: 4,
    projects: ['apps/docs', 'apps/web', 'packages/core', 'packages/ui'],
    deps: [1, 2, 2, 3, 3, 1, 2],
    reach: [0, 1, 3],
    files: { 'bun.lock': { hash: 'h1', digests: ['', 'dw', 'dc', 'du'] } },
  })
})

it('leaves out a field no project has an edge in', () => {
  const lock = dependenciesLock(root, [meta('a', 'a'), meta('b', 'b', ['a'])], new Map())
  expect(lock).toEqual({ version: 4, projects: ['a', 'b'], deps: [1, 1, 0], files: {} })
  const none = dependenciesLock(root, [meta('a', 'a')], new Map())
  expect(none).toEqual({ version: 4, projects: ['a'], files: {} })
  const read = parseDependenciesLock(new TextEncoder().encode(JSON.stringify(lock)))!
  expect([dependantsOf(read, 'a'), dependantsOf(read, 'b')]).toEqual([['b'], []])
})

it('records the other files the digests read, sorted, and only when there are any', () => {
  const withExtras = new Map([
    ['bun.lock', { hash: 'h1', projects: {}, extras: { 'patches/b.patch': 'hb', 'a/x': 'ha' } }],
  ])
  const lock = dependenciesLock(root, metas, withExtras)
  expect(JSON.stringify(lock.files)).toBe(
    '{"bun.lock":{"hash":"h1","digests":["","","",""],"extras":{"a/x":"ha","patches/b.patch":"hb"}}}',
  )
  expect(recordedDigests(lock, 'bun.lock')!.extras).toEqual({
    'a/x': 'ha',
    'patches/b.patch': 'hb',
  })
  expect(recordedDigests(dependenciesLock(root, metas, files), 'bun.lock')!.extras).toEqual({})
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
})

it('reads nothing from a missing file, another version or another shape', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  expect(parseDependenciesLock(null)).toBeNull()
  expect(parseDependenciesLock(enc({ version: 1, projects: {}, files: {} }))).toBeNull()
  expect(
    parseDependenciesLock(enc({ version: 2, projects: [], deps: [], reach: [], files: {} })),
  ).toBeNull()
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
// of the top level alone let `files: { "bun.lock": null }` or `deps: [5]`
// through, and the first lookup threw a raw TypeError instead of the
// "invalid, run `vx lock`" refusal.
it('reads nothing from a lock whose entries are not this shape', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const good = { version: 4, projects: ['a', 'b', 'c'], deps: [1, 1, 0, 2, 2, 0, 1], files: {} }
  expect(parseDependenciesLock(enc(good))).not.toBeNull()
  const rec = { hash: 'h', digests: ['', 'd', ''] }
  for (const bad of [
    { projects: ['a', 5] },
    { deps: [[], [0]] },
    { deps: {} },
    { deps: [1, 1, '0'] },
    { deps: [1, 1, 3] },
    { deps: [3, 1, 0] },
    { deps: [1, 0] },
    { deps: [1, 2, 0] },
    { deps: [2, 1, 0, 1, 1, 0] },
    { deps: [1, 1.5, 0] },
    { reach: [null] },
    { files: [] },
    { files: { 'bun.lock': null } },
    { files: { 'bun.lock': { ...rec, hash: 5 } } },
    { files: { 'bun.lock': { ...rec, digests: {} } } },
    { files: { 'bun.lock': { ...rec, digests: ['', 'd'] } } },
    { files: { 'bun.lock': { ...rec, digests: ['', 7, ''] } } },
    { files: { 'bun.lock': { ...rec, extras: [] } } },
    { files: { 'bun.lock': { ...rec, extras: { x: 1 } } } },
  ]) {
    expect([bad, parseDependenciesLock(enc({ ...good, ...bad }))]).toEqual([bad, null])
  }
  expect(
    parseDependenciesLock(enc({ ...good, files: { 'bun.lock': { ...rec, extras: { x: 'h' } } } })),
  ).not.toBeNull()
})
