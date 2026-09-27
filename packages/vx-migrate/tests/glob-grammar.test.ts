// The sweep of glob-grammar.ts (G-8): each row fails with one line of the
// translation undone. A wrong translation is a key fact: a positive glob
// that reads as a literal keys on nothing, and a negation that grows
// excludes an input. The shapes the adapters rely on are held through
// them (nx-helpers-sweep, turbo-map-sweep); these are the rest.
import { describe, expect, it } from 'bun:test'
import { minimatchToVx } from '../src/glob-grammar.js'

describe('minimatchToVx: what the sweep found unheld', () => {
  it('`@(a|b)` is exactly one of them, never neither', () => {
    expect(minimatchToVx('x.@(js|ts)', false)).toBe('x.{js,ts}')
    expect(minimatchToVx('x.@(js|ts)', true)).toBe('x.{js,ts}')
  })

  it.each([
    // An extglob nested in another: the inner one translates, the outer
    // one would stay a literal that matches nothing.
    ['?(a|@(b)).js', false],
    ['?(a|+(b)).js', true],
    // An alternative holding a brace or a comma would split into others.
    ['?(a,b|c).js', false],
    ['@({a}|c).js', true],
    // An empty class, and one holding a brace, a comma or a slash.
    ['x[].js', false],
    ['x[{,].js', false],
    ['x[a/].js', true],
  ])('%s (negated: %p) has no safe form', (glob, negated) => {
    expect(minimatchToVx(glob, negated)).toBeNull()
  })
})
