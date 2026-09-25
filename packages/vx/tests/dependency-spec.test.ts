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

  // The parser is pure — every malformed shape throws DependencySpecError.
  const invalid: Array<{ raw: string; reason: RegExp }> = [
    { raw: '', reason: /empty spec/ },
    { raw: '!', reason: /negation with no body/ },
    { raw: '^', reason: /"\^" with no task name/ },
    { raw: '^a#b', reason: /cannot combine with "pkg#task"/ },
    { raw: 'pkg#', reason: /non-empty project AND task/ },
    { raw: '#task', reason: /non-empty project AND task/ },
  ]
  for (const { raw, reason } of invalid) {
    it(`throws DependencySpecError on ${JSON.stringify(raw)}`, () => {
      expect(() => parseDependencySpec(raw)).toThrow(DependencySpecError)
      expect(() => parseDependencySpec(raw)).toThrow(reason)
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
})
