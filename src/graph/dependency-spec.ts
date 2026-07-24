// Parser for the Turbo/Nx-style task-edge micro-syntax used in
// `dependsOn` and `cache.inputs.tasks`. Returns a small discriminated
// union the graph builder + cache filter both consume.

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
    super(`Invalid dependency spec "${raw}": ${message}`)
  }
}

/**
 * Parse one `dependsOn` / `cache.inputs.tasks` entry.
 *
 *   `name`       → self.name
 *   `^name`      → every dep workspace's `name` task
 *   `pkg#name`   → specific package's `name` task (cross-edge)
 *   `*`          → all same-project upstream (filter-only)
 *   `^*`         → all dep upstream (filter-only)
 *   `!<form>`    → negation of any of the above (filter-only)
 *
 * Wildcards and negation are accepted everywhere — callers (the graph
 * builder vs the filter) decide which ones make semantic sense and
 * surface their own validation errors. This keeps the parser pure.
 */
/** True when a task form is a `*` pattern (`build.*`) rather than an exact name. */
export function isTaskPattern(task: string): boolean {
  return task.includes('*')
}

/**
 * Compile a `*`-only glob over task names: `build.*` → /^build\..*$/.
 * `*` is the sole metacharacter — everything else matches literally, so the
 * dotted-namespace convention (`build.bun.linux-x64`) needs no escaping by
 * the user.
 */
export function compileTaskPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
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
      throw new DependencySpecError(raw, 'pkg#task requires a non-empty project AND task')
    }
    return { kind: 'cross', project, task, negated }
  }

  return { kind: 'self', task: s, negated }
}
