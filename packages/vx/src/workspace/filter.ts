// Filter DSL — pnpm-style selectors for `--filter`.
//
//   <pattern>        name glob, `*` = any characters (e.g. foo, @scope/*)
//   ./<dir>          packages whose dir is at or under <dir> (relative to workspace root)
//   {<dir>}          same as ./<dir>
//   <pattern>...     pattern + its transitive workspace dependencies
//   ...<pattern>     pattern + its transitive workspace dependents
//   <pattern>^...    only the transitive deps of pattern (excluding the matched package)
//   !<pattern>       exclude packages matching pattern from the selection
//   [<since>]        projects affected since the given git ref
//                    (Turbo-style; resolved upstream of applyFilters via
//                    `affectedProjects` since it needs FS + git access)
//
// Filters are evaluated in order. If any include filter is present, the base
// set is empty and matched/expanded packages are added. If only excludes are
// given, the base set is "all projects" and excluded packages are removed.

import path from 'node:path'
import type { PackageGraph } from './package-graph.js'
import type { ProjectMeta } from './workspace.js'

export interface ParsedFilter {
  raw: string
  negate: boolean
  withDeps: boolean
  withDependents: boolean
  onlyDeps: boolean
  isPath: boolean
  /** Glob pattern (for name match) or absolute path (for path match). */
  matcher: string
  /**
   * When non-undefined, this filter is a git-relative `[<since>]`
   * selector. The matcher field is unused; the CLI resolves the ref
   * to a concrete set of project names before calling applyFilters.
   */
  gitSince?: string
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter {
  let s = raw
  const negate = s.startsWith('!')
  if (negate) s = s.slice(1)

  const withDependents = s.startsWith('...')
  if (withDependents) s = s.slice(3)

  let onlyDeps = false
  let withDeps = false
  if (s.endsWith('^...')) {
    onlyDeps = true
    s = s.slice(0, -4)
  } else if (s.endsWith('...')) {
    withDeps = true
    s = s.slice(0, -3)
  }

  // `[<since>]` git-relative selector. Suffix walks already ran above,
  // so `[main]...` parses as `[main]` with withDeps=true.
  if (s.startsWith('[') && s.endsWith(']')) {
    return {
      raw,
      negate,
      withDeps,
      withDependents,
      onlyDeps,
      isPath: false,
      matcher: '',
      gitSince: s.slice(1, -1),
    }
  }

  let isPath = false
  let matcher = s
  if (s.startsWith('./') || s === '.') {
    isPath = true
    matcher = path.resolve(workspaceRoot, s)
  } else if (s.startsWith('{') && s.endsWith('}')) {
    isPath = true
    matcher = path.resolve(workspaceRoot, s.slice(1, -1))
  }

  return { raw, negate, withDeps, withDependents, onlyDeps, isPath, matcher }
}

function matchProjects(
  filter: ParsedFilter,
  projects: ProjectMeta[],
  affectedByFilter: Map<ParsedFilter, Set<string>> | undefined,
): string[] {
  // `[<since>]` selectors are pre-resolved by the caller (the parser
  // is pure; git access happens upstream). Use the provided set as
  // the match set for this filter.
  if (filter.gitSince !== undefined) {
    return [...(affectedByFilter?.get(filter) ?? new Set())]
  }
  const out: string[] = []
  if (filter.isPath) {
    const prefix = filter.matcher + path.sep
    for (const p of projects) {
      if (p.dir === filter.matcher || p.dir.startsWith(prefix)) out.push(p.name)
    }
    return out
  }
  if (!filter.matcher.includes('*')) {
    for (const p of projects) {
      if (p.name === filter.matcher) out.push(p.name)
    }
    return out
  }
  const re = compileNameGlob(filter.matcher)
  for (const p of projects) {
    if (re.test(p.name)) out.push(p.name)
  }
  return out
}

/**
 * Compile a name pattern where `*` is the sole metacharacter and means "any
 * characters" — pnpm's rule. A path glob would treat `/` as a separator, so
 * `*` could never cross the `@scope/` boundary: `--filter '*'` would select
 * only UNSCOPED packages, and `*core*` would match nothing at all.
 */
function compileNameGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /**
   * Pre-resolved affected-project sets for each `[<since>]` filter.
   * The caller (CLI / programmatic embedder) runs the git work and
   * stuffs results in this map before calling applyFilters, which
   * stays pure + sync.
   */
  affectedByFilter?: Map<ParsedFilter, Set<string>>
  /**
   * Called once per filter that matched zero projects, before expansion.
   * Only the TOTAL empty selection is an error, so without this a typo among
   * several filters silently under-selects.
   */
  onNoMatch?: (filter: ParsedFilter) => void
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string> {
  const allNames = opts.projects.map((p) => p.name)
  const hasInclude = opts.filters.some((f) => !f.negate)
  const selected = new Set<string>(hasInclude ? [] : allNames)

  for (const f of opts.filters) {
    const matched = matchProjects(f, opts.projects, opts.affectedByFilter)
    if (matched.length === 0) opts.onNoMatch?.(f)
    const expanded = new Set<string>()
    for (const name of matched) {
      if (!f.onlyDeps) expanded.add(name)
      if (f.withDeps || f.onlyDeps) {
        for (const d of opts.graph.transitiveDeps(name)) expanded.add(d)
      }
      if (f.withDependents) {
        for (const d of opts.graph.transitiveDependents(name)) expanded.add(d)
      }
    }
    if (f.negate) {
      for (const name of expanded) selected.delete(name)
    } else {
      for (const name of expanded) selected.add(name)
    }
  }

  return selected
}
