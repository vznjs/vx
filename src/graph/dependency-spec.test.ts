import { describe, expect, it } from 'bun:test'
import { DependencySpecError, parseDependencySpec } from './dependency-spec.ts'

describe('parseDependencySpec', () => {
  it('parses a bare name as a same-project edge', () => {
    expect(parseDependencySpec('build')).toEqual({
      kind: 'self',
      task: 'build',
      negated: false,
    })
  })

  it('parses ^name as a workspace-dep edge', () => {
    expect(parseDependencySpec('^build')).toEqual({
      kind: 'deps',
      task: 'build',
      negated: false,
    })
  })

  it('parses pkg#name as a cross-project edge', () => {
    expect(parseDependencySpec('@scope/pkg#build')).toEqual({
      kind: 'cross',
      project: '@scope/pkg',
      task: 'build',
      negated: false,
    })
  })

  it('parses * as wildcardSelf', () => {
    expect(parseDependencySpec('*')).toEqual({ kind: 'wildcardSelf', negated: false })
  })

  it('parses ^* as wildcardDeps', () => {
    expect(parseDependencySpec('^*')).toEqual({ kind: 'wildcardDeps', negated: false })
  })

  it('parses negation', () => {
    expect(parseDependencySpec('!build')).toEqual({
      kind: 'self',
      task: 'build',
      negated: true,
    })
    expect(parseDependencySpec('!^build')).toEqual({
      kind: 'deps',
      task: 'build',
      negated: true,
    })
    expect(parseDependencySpec('!pkg#build')).toEqual({
      kind: 'cross',
      project: 'pkg',
      task: 'build',
      negated: true,
    })
    expect(parseDependencySpec('!*')).toEqual({ kind: 'wildcardSelf', negated: true })
    expect(parseDependencySpec('!^*')).toEqual({ kind: 'wildcardDeps', negated: true })
  })

  it('rejects an empty spec', () => {
    expect(() => parseDependencySpec('')).toThrow(DependencySpecError)
  })

  it('rejects a lone !', () => {
    expect(() => parseDependencySpec('!')).toThrow(DependencySpecError)
  })

  it('rejects a lone ^', () => {
    expect(() => parseDependencySpec('^')).toThrow(DependencySpecError)
  })

  it('rejects ^pkg#name (cannot combine forms)', () => {
    expect(() => parseDependencySpec('^pkg#build')).toThrow(DependencySpecError)
  })

  it('rejects pkg# with empty task', () => {
    expect(() => parseDependencySpec('pkg#')).toThrow(DependencySpecError)
  })

  it('rejects #task with empty project', () => {
    expect(() => parseDependencySpec('#build')).toThrow(DependencySpecError)
  })
})
