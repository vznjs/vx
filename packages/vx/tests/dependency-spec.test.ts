import { describe, expect, it } from 'bun:test'
import {
  compileTaskPattern,
  DependencySpecError,
  isTaskPattern,
  parseDependencySpec,
} from '../src/graph/dependency-spec.js'

describe('parseDependencySpec', () => {
  it('parses the concrete forms', () => {
    expect(parseDependencySpec('build')).toEqual({ kind: 'self', task: 'build', negated: false })
    expect(parseDependencySpec('^build')).toEqual({ kind: 'deps', task: 'build', negated: false })
    expect(parseDependencySpec('pkg#build')).toEqual({
      kind: 'cross',
      project: 'pkg',
      task: 'build',
      negated: false,
    })
    expect(parseDependencySpec('*')).toEqual({ kind: 'wildcardSelf', negated: false })
    expect(parseDependencySpec('^*')).toEqual({ kind: 'wildcardDeps', negated: false })
  })

  it('carries the negation flag through each form', () => {
    expect(parseDependencySpec('!build')).toEqual({ kind: 'self', task: 'build', negated: true })
    expect(parseDependencySpec('!^build')).toEqual({ kind: 'deps', task: 'build', negated: true })
    expect(parseDependencySpec('!*')).toEqual({ kind: 'wildcardSelf', negated: true })
    expect(parseDependencySpec('!^*')).toEqual({ kind: 'wildcardDeps', negated: true })
  })

  // The parser is pure — every malformed shape throws DependencySpecError,
  // whose message names the raw spec (the graph and the filter print it).
  const invalid: Array<{ raw: string; message: string }> = [
    { raw: '', message: 'Invalid dependency spec "": empty spec' },
    { raw: '!', message: 'Invalid dependency spec "!": negation with no body' },
    { raw: '^', message: 'Invalid dependency spec "^": "^" with no task name' },
    {
      raw: '^a#b',
      message: 'Invalid dependency spec "^a#b": "^" cannot combine with "pkg#task" — pick one',
    },
    {
      raw: 'pkg#',
      message: 'Invalid dependency spec "pkg#": pkg#task requires a non-empty project AND task',
    },
    {
      raw: '#task',
      message: 'Invalid dependency spec "#task": pkg#task requires a non-empty project AND task',
    },
  ]
  for (const { raw, message } of invalid) {
    it(`throws DependencySpecError on ${JSON.stringify(raw)}`, () => {
      let err: unknown
      try {
        parseDependencySpec(raw)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DependencySpecError)
      expect((err as DependencySpecError).message).toBe(message)
    })
  }
})

describe('a cross edge splits on the first #', () => {
  it('so a task name that holds one round-trips', () => {
    expect(parseDependencySpec('a#b#c')).toEqual({
      kind: 'cross',
      project: 'a',
      task: 'b#c',
      negated: false,
    })
  })
})

describe('task-name patterns', () => {
  it('a * anywhere makes a pattern', () => {
    expect(isTaskPattern('build.*')).toBe(true)
    expect(isTaskPattern('*.linux')).toBe(true)
    expect(isTaskPattern('build.*.linux')).toBe(true)
    expect(isTaskPattern('build')).toBe(false)
  })

  it('match the whole name, with every other character literal', () => {
    const re = compileTaskPattern('build.*')
    expect(re.test('build.bun')).toBe(true)
    // The dot is literal, not "any character".
    expect(re.test('buildx')).toBe(false)
    // Anchored at both ends.
    expect(re.test('prebuild.x')).toBe(false)
    expect(compileTaskPattern('build.bun').test('build.bun.linux')).toBe(false)
  })

  it('a * matches any run of characters, the empty run too, at every *', () => {
    expect(compileTaskPattern('build.*').test('build.')).toBe(true)
    const re = compileTaskPattern('*.bun.*')
    expect(re.test('build.bun.linux')).toBe(true)
    expect(re.test('build.bun*')).toBe(false)
  })

  // A task name may hold any of these, so a pattern around one must match
  // it literally, not as regex syntax (a wrong match is a wrong edge).
  const literal: Array<[pattern: string, name: string, notName: string]> = [
    ['a.b.*', 'a.b.c', 'a.bxc'],
    ['a+*', 'a+b', 'aab'],
    ['ab?*', 'ab?c', 'ac'],
    ['a^b*', 'a^b', 'ab'],
    ['a$b*', 'a$b', 'ab'],
    ['a{2}*', 'a{2}', 'aa'],
    ['(a)*', '(a)', 'a'],
    ['a|b*', 'a|b', 'a'],
    ['a\\d*', 'a\\d', 'a1'],
  ]
  for (const [pattern, name, notName] of literal) {
    it(`${pattern} matches ${name} and not ${notName}`, () => {
      const re = compileTaskPattern(pattern)
      expect(re.test(name)).toBe(true)
      expect(re.test(notName)).toBe(false)
    })
  }
})
