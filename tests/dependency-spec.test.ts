import { describe, expect, it } from 'bun:test'
import { DependencySpecError, parseDependencySpec } from '../src/graph/dependency-spec.js'

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
