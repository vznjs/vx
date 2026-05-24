// Pure parser for the Turbo/Nx-style task-edge micro-syntax used in
// `dependsOn` and (future) `cache.inputs.tasks`. No graph state, no
// FS, no globals — easy to embed in extension modules.

export type DependencySpec =
  | { kind: 'self'; task: string; negated: boolean }
  | { kind: 'deps'; task: string; negated: boolean }
  | { kind: 'cross'; project: string; task: string; negated: boolean }
  | { kind: 'wildcardSelf'; negated: boolean }
  | { kind: 'wildcardDeps'; negated: boolean }

export class DependencySpecError extends Error {
  constructor(
    public readonly raw: string,
    message: string,
  ) {
    super(`invalid dependency spec "${raw}": ${message}`)
    this.name = 'DependencySpecError'
  }
}

export function parseDependencySpec(raw: string): DependencySpec {
  if (raw.length === 0) throw new DependencySpecError(raw, 'empty spec')

  let negated = false
  let s = raw
  if (s.startsWith('!')) {
    negated = true
    s = s.slice(1)
    if (s.length === 0) throw new DependencySpecError(raw, 'negation with no body')
  }

  if (s.startsWith('^')) {
    const rest = s.slice(1)
    if (rest.length === 0) throw new DependencySpecError(raw, '"^" with no task name')
    if (rest === '*') return { kind: 'wildcardDeps', negated }
    if (rest.includes('#')) {
      throw new DependencySpecError(raw, '"^" cannot combine with "pkg#task" — pick one')
    }
    return { kind: 'deps', task: rest, negated }
  }

  if (s === '*') return { kind: 'wildcardSelf', negated }

  const hashIdx = s.indexOf('#')
  if (hashIdx >= 0) {
    const project = s.slice(0, hashIdx)
    const task = s.slice(hashIdx + 1)
    if (!project || !task) {
      throw new DependencySpecError(raw, 'pkg#task requires non-empty project AND task')
    }
    return { kind: 'cross', project, task, negated }
  }

  return { kind: 'self', task: s, negated }
}
