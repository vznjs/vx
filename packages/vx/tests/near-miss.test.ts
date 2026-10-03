// The one near-miss rule behind every "did you mean" hint (task names,
// `pkg#task` halves, project names, flags, verbs, and the inspection verbs'
// short lists). Each surface used to carry its own copy of "within two
// edits", and `vx why` used a substring rule that found nothing for a typo.
import { describe, expect, it } from 'bun:test'
import { listed, nearMatches, nearest } from '../src/util/index.js'

describe('nearest', () => {
  it('picks the closest candidate within two edits and never the name itself', () => {
    expect(nearest('buidl', ['build', 'test', 'lint'])).toBe('build')
    expect(nearest('build', ['build', 'test'])).toBeUndefined()
    expect(nearest('deploy', ['build', 'test'])).toBeUndefined() // three edits and more: no guess
  })
  it('prefers the nearer of two candidates', () => {
    expect(nearest('tset', ['test', 'tests'])).toBe('test')
  })
})

describe('nearMatches', () => {
  it('lists edit-distance hits first, then substring hits, up to the limit, deduped', () => {
    expect(nearMatches('buld', ['build', 'build-docs', 'test'])).toEqual(['build'])
    expect(nearMatches('bui', ['build', 'build-docs', 'test'])).toEqual(['build', 'build-docs'])
    expect(nearMatches('app', ['app#build', 'app#test', 'other#lint', 'app#lint'], 2)).toEqual([
      'app#build',
      'app#test',
    ])
    expect(nearMatches('deploy', ['deploy', 'build', 'test'])).toEqual([]) // itself never; the rest too far
  })

  // E-17's sweep of edit-distance.ts: each of these could go with the
  // suite green.
  it('orders the edit-distance hits nearest first, whatever order they came in', () => {
    expect(nearMatches('build', ['bxixd', 'buxld'])).toEqual(['buxld', 'bxixd'])
  })

  it('offers a candidate the query contains, and matches containment case-insensitively', () => {
    // `vx why build-and-test` names more than the recorded `build`.
    expect(nearMatches('build-and-test', ['build', 'lint'])).toEqual(['build'])
    expect(nearMatches('web', ['MyWebApp', 'api'])).toEqual(['MyWebApp'])
  })

  it('never returns more than the limit, however many are near', () => {
    expect(nearMatches('ab', ['aa', 'bb', 'ac', 'cb', 'ax'])).toEqual(['aa', 'bb', 'ac'])
  })
})

describe('listed', () => {
  it('sorts, dedupes, and counts what is past the limit (M-56)', () => {
    expect(listed(['b', 'a', 'b'])).toBe('a, b')
    expect(listed(['e', 'd', 'c', 'b', 'a'], 3)).toBe('a, b, c, and 2 more')
    // CONTROL: exactly the limit is no "more".
    expect(listed(['b', 'a', 'c'], 3)).toBe('a, b, c')
  })
})
