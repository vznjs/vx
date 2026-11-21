// `.vx/dependencies.lock` is text, one line per project keyed by its name
// and sorted, so a merge touches only the projects each branch changed:
// `name⇥deps⇥reach⇥digests`, a hex digest as base64url. The same workspace
// writes the same bytes.

import { expect, it } from 'bun:test'
import {
  dependantsOf,
  dependenciesLock,
  parseDependenciesLock,
  recordedDigests,
  sameRecord,
} from '../src/workspace/dependencies-lock.js'
import type { ProjectMeta } from '../src/workspace/index.js'

const meta = (name: string, deps?: string[], reach?: string[]): ProjectMeta =>
  ({
    name,
    dir: `/ws/${name}`,
    configPath: null,
    ...(deps ? { deps } : {}),
    ...(reach ? { reach } : {}),
  }) as ProjectMeta

const metas = [meta('web', ['ui', 'core']), meta('ui', ['core']), meta('core'), meta('docs', [], ['ui'])]
const H = '0123456789abcdef'
const D = 'fedcba9876543210'
const files = new Map([['bun.lock', { hash: H, projects: { web: D, ui: 'du', core: D } }]])
const reread = (text: string) => parseDependenciesLock(new TextEncoder().encode(text))!

it('writes a line per project, by name, sorted: deps, reach, digests', () => {
  expect(dependenciesLock(metas, files).text).toBe(
    '{"version":5,"files":["bun.lock","ASNFZ4mrze8"],"edges":true}\n' +
      'core\t\t\t_ty6mHZUMhA\n' +
      'docs\t\tui\n' +
      'ui\tcore\t\t=du\n' +
      'web\tcore,ui\t\t_ty6mHZUMhA\n',
  )
})

it('reads back what it wrote: edges, dependants and digests by name', () => {
  const lock = reread(dependenciesLock(metas, files).text)
  expect(lock.names).toEqual(['core', 'docs', 'ui', 'web'])
  expect(lock.edgeSource).toBe(true)
  expect(lock.edges('web')).toEqual({ deps: ['core', 'ui'], reach: [] })
  expect(lock.edges('docs')).toEqual({ deps: [], reach: ['ui'] })
  expect(lock.edges('gone')).toBeUndefined()
  expect(dependantsOf(lock, 'ui')).toEqual(['docs', 'web'])
  const rec = recordedDigests(lock, 'bun.lock')!
  expect([rec.hash, rec.of('web'), rec.of('ui'), rec.of('docs'), rec.of('x')]).toEqual([
    H,
    D,
    'du',
    undefined,
    undefined,
  ])
  expect([rec.has('docs'), rec.has('x')]).toEqual([true, false])
  expect(recordedDigests(lock, 'pnpm-lock.yaml')).toBeUndefined()
})

it('records no edge source when no plugin gave deps', () => {
  const lock = dependenciesLock([meta('a'), meta('b')], new Map())
  expect(lock.text).toBe('{"version":5,"files":[]}\na\nb\n')
  expect(reread(lock.text).edgeSource).toBe(false)
})

// A comma or tab in a name or digest would break a field: such a field is a
// JSON array, such a key a JSON string, and both read back.
it('reads back names and digests a separator could break', () => {
  const odd = [meta('a,b', ['c\td']), meta('c\td'), meta('[x')]
  const two = new Map([
    ['a.lock', { hash: 'ha', projects: { 'a,b': 'x,y' } }],
    ['b.lock', { hash: 'hb', projects: { '[x': 'q' } }],
  ])
  const lock = reread(dependenciesLock(odd, two).text)
  expect(lock.names).toEqual(['[x', 'a,b', 'c\td'])
  expect(lock.edges('a,b')!.deps).toEqual(['c\td'])
  expect(recordedDigests(lock, 'a.lock')!.of('a,b')).toBe('x,y')
  expect(recordedDigests(lock, 'b.lock')!.of('[x')).toBe('q')
  expect(dependantsOf(lock, 'c\td')).toEqual(['a,b'])
})

it('records the other files the digests read, sorted', () => {
  const withExtras = new Map([
    ['bun.lock', { hash: H, projects: {}, extras: { 'patches/b.patch': 'hb', 'a/x': 'ha' } }],
  ])
  const lock = reread(dependenciesLock(metas, withExtras).text)
  expect(JSON.stringify(recordedDigests(lock, 'bun.lock')!.extras)).toBe(
    '{"a/x":"ha","patches/b.patch":"hb"}',
  )
})

it('the same projects in another order write the same text', () => {
  expect(dependenciesLock([...metas].reverse(), files).text).toBe(
    dependenciesLock(metas, files).text,
  )
})

it('compares records: an extra-only hash move skips that file digests', () => {
  const base = dependenciesLock(metas, files)
  expect(sameRecord(reread(base.text), base)).toBe(true)
  const moved = new Map([['bun.lock', { hash: H, projects: { web: 'other', ui: 'du', core: D } }]])
  expect(sameRecord(base, dependenciesLock(metas, moved))).toBe(false)
  const ex = (h: string, web: string) =>
    new Map([['bun.lock', { hash: H, projects: { web }, extras: { p: h } }]])
  expect(sameRecord(dependenciesLock(metas, ex('a', 'x')), dependenciesLock(metas, ex('b', 'y')))).toBe(true)
  expect(sameRecord(base, dependenciesLock(metas.slice(1), files))).toBe(false)
  const edged = [meta('web', ['ui']), ...metas.slice(1)]
  expect(sameRecord(base, dependenciesLock(edged, files))).toBe(false)
})

it('reads nothing from a missing file, another format or an older version', () => {
  const enc = (t: string) => new TextEncoder().encode(t)
  expect(parseDependenciesLock(null)).toBeNull()
  expect(parseDependenciesLock(enc('{"version":4,"graph":[]}'))).toBeNull()
  expect(parseDependenciesLock(enc('VXDL'))).toBeNull()
})

it('refuses a lock a newer vx wrote: re-locking would write the older version over it', () => {
  const bytes = new TextEncoder().encode('{"version":99}\n')
  expect(() => parseDependenciesLock(bytes)).toThrow(
    '.vx/dependencies.lock was written by a newer vx (version 99; this vx reads 5) — upgrade vx',
  )
})

// A committed file a merge or a hand edit can break inside: the refusal is
// "invalid, run `vx lock`", never a raw TypeError at a lookup.
it('reads nothing from a lock whose lines are broken, and refuses a broken field', () => {
  const good = dependenciesLock(metas, files).text
  const [head, ...lines] = good.trimEnd().split('\n')
  const text = (...ls: string[]) => new TextEncoder().encode(`${[head, ...ls].join('\n')}\n`)
  expect(parseDependenciesLock(text(...lines))).not.toBeNull()
  // Two lines of one name, or out of order: a merge that kept both sides.
  expect(parseDependenciesLock(text(lines[0]!, ...lines))).toBeNull()
  expect(parseDependenciesLock(text(...[...lines].reverse()))).toBeNull()
  expect(parseDependenciesLock(new TextEncoder().encode(good.trimEnd()))).toBeNull()
  // An edge to no project, or a bad digest, refuses when read.
  const lock = parseDependenciesLock(text(lines[0]!, lines[1]!, 'ui\tnone', lines[3]!))!
  expect(() => lock.edges('ui')).toThrow('.vx/dependencies.lock is invalid, run `vx lock`')
  const digest = parseDependenciesLock(text(lines[0]!, lines[1]!, 'ui\t\t\t!!', lines[3]!))!
  expect(() => recordedDigests(digest, 'bun.lock')!.of('ui')).toThrow('is invalid')
})
