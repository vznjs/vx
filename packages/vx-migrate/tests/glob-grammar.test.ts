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
    // A range across kinds or backwards, and a negated class in a negation.
    ['x[a-9].js', false],
    ['x[c-a].js', false],
    ['x[!a].js', true],
    ['x[^a].js', true],
    ['x[!].js', false],
  ])('%s (negated: %p) has no safe form', (glob, negated) => {
    expect(minimatchToVx(glob, negated)).toBeNull()
  })
})

// Turbo's wax and Nx's minimatch read `[a-c]` as a range: refused, a task
// fell back to keying every package file (a probe of `src/[a-c]*.js`
// re-keyed on any edit, 2026-10-02).
describe('minimatchToVx: classes', () => {
  it.each([
    ['src/[a-c]*.js', false, 'src/{[a-c],a,b,c}*.js'],
    ['src/[a-c]*.js', true, 'src/{a,b,c}*.js'],
    ['v[0-2x].js', true, 'v{0,1,2,x}.js'],
    ['[-a].js', true, '{-,a}.js'],
    ['[a-].js', true, '{a,-}.js'],
    ['x[A-C].js', true, 'x{A,B,C}.js'],
    // A negated class is any one character: a superset, safe to key on.
    ['src/[!_]*.ts', false, 'src/?*.ts'],
  ])('%s (negated: %p) is %s', (glob, negated, vx) => {
    expect(minimatchToVx(glob, negated)).toBe(vx)
  })
})
