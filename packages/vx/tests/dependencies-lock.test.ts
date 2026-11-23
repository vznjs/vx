// `.vx/dependencies.lock` is text, two lines per project keyed by its name,
// in name-hash order, so a merge touches only the projects each branch
// changed and git merges edits to neighbours: the name, then
// `⇥deps⇥reach⇥digests`, a hex digest as base64url. The same workspace
// writes the same bytes.

import { expect, it } from 'bun:test'
import {
  dependantsOf,
  dependenciesLock,
  dependenciesLockRefusal,
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

const metas = [
  meta('web', ['ui', 'core']),
  meta('ui', ['core']),
  meta('core'),
  meta('docs', [], ['ui']),
]
const D = 'fedcba9876543210'
const files = new Map([['bun.lock', { projects: { web: D, ui: 'du', core: D } }]])
const reread = (text: string) => parseDependenciesLock(new TextEncoder().encode(text))!

it('writes each project as its name line, then deps, reach and digests, in name-hash order', () => {
  expect(dependenciesLock(metas, files).text).toBe(
    '{"version":6,"files":["bun.lock"],"edges":true}\n' +
      'ui\n\tcore\t\t=du\n' +
      'web\n\tcore,ui\t\t_ty6mHZUMhA\n' +
      'core\n\t\t\t_ty6mHZUMhA\n' +
      'docs\n\t\tui\n',
  )
})

// The point of the layout: a name line stays put between two branches'
// edits to neighbouring projects, so git merges both.
it('git merges two branches that each move a neighbouring project', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  const dir = mkdtempSync(`${require('node:os').tmpdir()}/vx-deps-merge-`)
  const at = (n: string, t: string) => {
    writeFileSync(`${dir}/${n}`, t)
    return `${dir}/${n}`
  }
  const digests = (web: string, ui: string) =>
    new Map([['bun.lock', { projects: { web, ui, core: D } }]])
  const base = dependenciesLock(metas, digests(D, 'du')).text
  const ours = dependenciesLock(metas, digests('0123456789abcdef', 'du')).text
  const theirs = dependenciesLock(metas, digests(D, 'du2')).text
  const r = spawnSync('git', ['merge-file', '-p', at('o', ours), at('b', base), at('t', theirs)], {
    encoding: 'utf8',
  })
  rmSync(dir, { recursive: true, force: true })
  expect(r.status).toBe(0)
  expect(r.stdout).toBe(dependenciesLock(metas, digests('0123456789abcdef', 'du2')).text)
})

it('reads back what it wrote: edges, dependants and digests by name', () => {
  const lock = reread(dependenciesLock(metas, files).text)
  expect([...lock.names].sort()).toEqual(['core', 'docs', 'ui', 'web'])
  expect(lock.edgeSource).toBe(true)
  expect(lock.edges('web')).toEqual({ deps: ['core', 'ui'], reach: [] })
  expect(lock.edges('docs')).toEqual({ deps: [], reach: ['ui'] })
  expect(lock.edges('gone')).toBeUndefined()
  expect(dependantsOf(lock, 'ui').sort()).toEqual(['docs', 'web'])
  const rec = recordedDigests(lock, 'bun.lock')!
  expect([rec.of('web'), rec.of('ui'), rec.of('docs'), rec.of('x')]).toEqual([
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
  expect(lock.text).toBe('{"version":6,"files":[]}\nb\n\t\na\n\t\n')
  expect(reread(lock.text).edgeSource).toBe(false)
})

// A comma or tab in a name or digest would break a field: such a field is a
// JSON array, such a key a JSON string, and both read back.
it('reads back names and digests a separator could break', () => {
  const odd = [meta('a,b', ['c\td']), meta('c\td'), meta('[x')]
  const two = new Map([
    ['a.lock', { projects: { 'a,b': 'x,y' } }],
    ['b.lock', { projects: { '[x': 'q' } }],
  ])
  const lock = reread(dependenciesLock(odd, two).text)
  expect([...lock.names].sort()).toEqual(['[x', 'a,b', 'c\td'])
  expect(lock.edges('a,b')!.deps).toEqual(['c\td'])
  expect(recordedDigests(lock, 'a.lock')!.of('a,b')).toBe('x,y')
  expect(recordedDigests(lock, 'b.lock')!.of('[x')).toBe('q')
  expect(dependantsOf(lock, 'c\td')).toEqual(['a,b'])
})

it('records the other files the digests read, sorted', () => {
  const withExtras = new Map([
    ['bun.lock', { projects: {}, extras: { 'patches/b.patch': 'hb', 'a/x': 'ha' } }],
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
  const moved = new Map([['bun.lock', { projects: { web: 'other', ui: 'du', core: D } }]])
  expect(sameRecord(base, dependenciesLock(metas, moved))).toBe(false)
  const ex = (h: string, web: string) =>
    new Map([['bun.lock', { projects: { web }, extras: { p: h } }]])
  expect(
    sameRecord(dependenciesLock(metas, ex('a', 'x')), dependenciesLock(metas, ex('b', 'y'))),
  ).toBe(true)
  expect(sameRecord(base, dependenciesLock(metas.slice(1), files))).toBe(false)
  const edged = [meta('web', ['ui']), ...metas.slice(1)]
  expect(sameRecord(base, dependenciesLock(edged, files))).toBe(false)
})

it('reads nothing from a missing file, another format or an older version', () => {
  const enc = (t: string) => new TextEncoder().encode(t)
  expect(parseDependenciesLock(null)).toBeNull()
  expect(parseDependenciesLock(enc('{"version":4,"graph":[]}'))).toBeNull()
  expect(parseDependenciesLock(enc('{"version":5,"files":[]}\na\tb\n'))).toBeNull()
  expect(parseDependenciesLock(enc('VXDL'))).toBeNull()
})

it('refuses a lock a newer vx wrote: re-locking would write the older version over it', () => {
  const bytes = new TextEncoder().encode('{"version":99}\n')
  expect(() => parseDependenciesLock(bytes)).toThrow(
    '.vx/dependencies.lock was written by a newer vx (version 99; this vx reads 6) — upgrade vx',
  )
})

// An older vx's lock after an upgrade: the run names the version, as
// projects.lock's refusal does, not a bare "invalid".
it("names an older vx's version in the refusal, and a conflict or garbage apart", () => {
  expect(dependenciesLockRefusal('{"version":5,"files":[]}\n')).toBe(
    '.vx/dependencies.lock has unsupported version 5 (this vx expects 6) — re-run `vx lock`',
  )
  expect(dependenciesLockRefusal('{"version":6}\n<<<<<<< ours\n')).toContain('merge conflict')
  expect(dependenciesLockRefusal('VXDL')).toBe('.vx/dependencies.lock is invalid, run `vx lock`')
})

// A committed file a merge or a hand edit can break inside: the refusal is
// "invalid, run `vx lock`", never a raw TypeError at a lookup.
it('reads nothing from a lock whose lines are broken, and refuses a broken field', () => {
  const good = dependenciesLock(metas, files).text
  const [head, ...lines] = good.trimEnd().split('\n')
  const pairs = Array.from({ length: lines.length / 2 }, (_, i): [string, string] => [
    lines[2 * i]!,
    lines[2 * i + 1]!,
  ])
  const text = (...ls: string[]) => new TextEncoder().encode(`${[head, ...ls].join('\n')}\n`)
  expect(parseDependenciesLock(text(...lines))).not.toBeNull()
  // Two of one name: a merge that kept both sides.
  expect(parseDependenciesLock(text(...pairs[0]!, ...lines))).toBeNull()
  // A name with no fields' line, or a fields' line with no name.
  expect(parseDependenciesLock(text(pairs[0]![0], ...lines))).toBeNull()
  expect(parseDependenciesLock(text(pairs[0]![1], ...lines))).toBeNull()
  expect(parseDependenciesLock(new TextEncoder().encode(good.trimEnd()))).toBeNull()
  // The pairs in another order read the same.
  expect(parseDependenciesLock(text(...[...pairs].reverse().flat()))).not.toBeNull()
  // An edge to no project, or a bad digest, refuses when read.
  const ui = pairs.findIndex((p) => p[0] === 'ui')
  const swap = (v: string) => pairs.flatMap((p, i) => (i === ui ? [p[0], v] : p))
  const lock = parseDependenciesLock(text(...swap('\tnone')))!
  expect(() => lock.edges('ui')).toThrow('.vx/dependencies.lock is invalid, run `vx lock`')
  const digest = parseDependenciesLock(text(...swap('\t\t\t!!')))!
  expect(() => recordedDigests(digest, 'bun.lock')!.of('ui')).toThrow('is invalid')
})

// A merge conflict git left (both sides moved one project): the marker
// lines read as name lines.
it('reads nothing from a lock holding merge conflict markers', () => {
  const [head, ...lines] = dependenciesLock(metas, files).text.trimEnd().split('\n')
  // Each marker before a fields' line, as a name would be: only the markers say it is no lock.
  const marked = [head, '<<<<<<< ours', '\t', '=======', '\t', '>>>>>>> theirs', '\t', ...lines]
  expect(parseDependenciesLock(new TextEncoder().encode(`${marked.join('\n')}\n`))).toBeNull()
  // CONTROL: a name with no fields is a line `vx lock` writes.
  expect(
    parseDependenciesLock(new TextEncoder().encode(`${[head, ...lines].join('\n')}\n`)),
  ).not.toBeNull()
})
