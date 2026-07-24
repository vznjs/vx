import { describe, expect, it } from 'bun:test'
import { computeNestedProjectDirs } from '../src/workspace/index.js'

// Dirs use '/' — the fn joins with path.sep; on POSIX these are identical, and
// the tests assert the boundary logic, not the separator.
const entry = (name: string, dir: string) => ({ name, dir })

describe('computeNestedProjectDirs', () => {
  it('finds a nested project even when an interloping sibling sorts between parent and parent/', () => {
    // `foo-utils` (char '-' = 0x2D) sorts BETWEEN `foo` and `foo/` (sep 0x2F),
    // so a plain break-on-first-non-descendant would miss `foo/nested` and
    // silently break the project-boundary invariant.
    const r = computeNestedProjectDirs([
      entry('foo', '/repo/packages/foo'),
      entry('foo-utils', '/repo/packages/foo-utils'),
      entry('foobar', '/repo/packages/foobar'),
      entry('nested', '/repo/packages/foo/nested'),
    ])
    expect(r.get('foo')).toEqual(['/repo/packages/foo/nested'])
    // The interlopers are siblings, not parents.
    expect(r.get('foo-utils')).toEqual([])
    expect(r.get('foobar')).toEqual([])
    expect(r.get('nested')).toEqual([])
  })

  it('collects transitively nested descendants, skipping interlopers on both sides', () => {
    const r = computeNestedProjectDirs([
      entry('foo', '/repo/foo'),
      entry('foo-a', '/repo/foo-a'), // char '-' < '/' → sorts before foo/*
      entry('nested', '/repo/foo/nested'),
      entry('deep', '/repo/foo/nested/deep'),
      entry('foo2', '/repo/foo2'), // char '2' > '/' → sorts after foo/*
      entry('zzz', '/repo/zzz'),
    ])
    expect(r.get('foo')).toEqual(['/repo/foo/nested', '/repo/foo/nested/deep'])
    expect(r.get('nested')).toEqual(['/repo/foo/nested/deep'])
    expect(r.get('foo-a')).toEqual([])
    expect(r.get('foo2')).toEqual([])
  })

  it('a flat sibling layout has no nesting', () => {
    const r = computeNestedProjectDirs([
      entry('a', '/repo/a'),
      entry('b', '/repo/b'),
      entry('c', '/repo/c'),
    ])
    expect(r.get('a')).toEqual([])
    expect(r.get('b')).toEqual([])
    expect(r.get('c')).toEqual([])
  })

  it('does not treat a string-prefix sibling (foobar) as nested under foo', () => {
    const r = computeNestedProjectDirs([entry('foo', '/repo/foo'), entry('foobar', '/repo/foobar')])
    expect(r.get('foo')).toEqual([])
  })

  it('empty input → empty map', () => {
    expect(computeNestedProjectDirs([]).size).toBe(0)
  })
})
