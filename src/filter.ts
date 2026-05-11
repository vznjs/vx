// Filter DSL — pnpm-style selectors for `-F / --filter`.
//
//   <pattern>        name glob (e.g. foo, @scope/*)
//   ./<dir>          packages whose dir is at or under <dir> (relative to workspace root)
//   {<dir>}          same as ./<dir>
//   <pattern>...     pattern + its transitive workspace dependencies
//   ...<pattern>     pattern + its transitive workspace dependents
//   <pattern>^...    only the transitive deps of pattern (excluding the matched package)
//   !<pattern>       exclude packages matching pattern from the selection
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

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function matchProjects(filter: ParsedFilter, projects: ProjectMeta[]): string[] {
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
  const re = globToRegex(filter.matcher)
  for (const p of projects) {
    if (re.test(p.name)) out.push(p.name)
  }
  return out
}

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string> {
  const allNames = opts.projects.map((p) => p.name)
  const hasInclude = opts.filters.some((f) => !f.negate)
  const selected = new Set<string>(hasInclude ? [] : allNames)

  for (const f of opts.filters) {
    const matched = matchProjects(f, opts.projects)
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
