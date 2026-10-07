// Filter DSL — pnpm-style selectors for `--filter`.
//
//   <pattern>        name glob, `*` = any characters (e.g. foo, @scope/*)
//   ./<dir>          the package at <dir>, else the packages under it (relative to workspace root)
//   {<dir>}          same as ./<dir>
//   //               the workspace-root project only (Turbo's name for the root)
//   tag:<pattern>    the projects whose config `tags` hold a match (Nx's `tag:`)
//   <dir>/<glob>     a name with a `/` outside a scope that names no project:
//                    ./<dir>/<glob> (Nx's `--projects 'apps/*'`)
//   <pattern>...     pattern + its transitive workspace dependencies
//   ...<pattern>     pattern + its transitive workspace dependents
//   <pattern>^...    only the transitive deps of pattern (excluding the matched package)
//   ...^<pattern>    only the transitive dependents of pattern (excluding the matched package)
//   !<pattern>       exclude packages matching pattern from the selection
//   [<since>]        projects affected since the given git ref; after a name
//                    or {dir} selector, the selected ones only (D-44)
//                    (Turbo-style; resolved upstream of applyFilters via
//                    `affectedProjects` since it needs FS + git access)
//
// Filters are evaluated in order. If any include filter is present, the base
// set is empty and matched/expanded packages are added. If only excludes are
// given, the base set is "all projects" and excluded packages are removed.

import path from 'node:path'
import { BUN_GLOB_WILDCARDS, UserError } from '../util/index.js'
import type { PackageGraph } from './package-graph.js'
import type { ProjectMeta } from './workspace.js'

export interface ParsedFilter {
  raw: string
  negate: boolean
  withDeps: boolean
  withDependents: boolean
  onlyDeps: boolean
  /** `...^<pattern>`: the dependents alone, the matched package left out. */
  onlyDependents: boolean
  isPath: boolean
  /** Glob pattern (for name match) or absolute path (for path match). */
  matcher: string
  /**
   * When non-undefined, this filter is a git-relative `[<since>]`
   * selector: bare (`matcher` empty), or narrowing a name or `{dir}`
   * selector (`@scope/*[main]`, D-44). The CLI resolves the ref to a
   * concrete set of project names before calling applyFilters.
   */
  gitSince?: string
  /**
   * `<name>...[<since>]`: the named packages that changed OR depend on one
   * that did, as Turbo reads it (2.5.8: `@acme/api...[HEAD]` is api when
   * only its dependency db changed). Not a walk: no dependency is added.
   */
  sinceViaDeps?: true
  /** A path form carrying a glob (`./packages/*`): matched over the root-relative project dir. */
  pathGlob?: Bun.Glob
  /** `./a/**`'s `a`: a trailing `**` matches zero dirs, and `Bun.Glob` does not (D-84). */
  pathGlobBase?: Bun.Glob
  /** The workspace root `pathGlob` is relative to. */
  pathRoot?: string
  /** `//`: the project at `matcher` itself, never the ones under it. */
  exactDir?: true
  /** `tag:<pattern>`: `matcher` is a glob over the projects' tags, not their names. */
  tag?: true
  /**
   * `apps/*`: a name pattern holding a `/` outside a scope, read as
   * `./apps/*` when it names no project, as Nx's `--projects` reads it.
   */
  dirFallback?: ParsedFilter
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter {
  let s = raw
  const negate = s.startsWith('!')
  if (negate) s = s.slice(1)

  const withDependents = s.startsWith('...')
  if (withDependents) s = s.slice(3)
  // `...^a`: cli.md listed it, and the `^` stayed in the name glob, so it
  // matched no package and the run refused (item 890).
  const onlyDependents = withDependents && s.startsWith('^')
  if (onlyDependents) s = s.slice(1)

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
      onlyDependents,
      isPath: false,
      matcher: '',
      gitSince: s.slice(1, -1),
    }
  }

  // `<selector>[<since>]`: the selected packages that changed since the
  // ref (D-44). Turbo and pnpm read `@scope/*[HEAD]` and `{./apps/*}[main]`
  // so; vx read the whole as one name glob and matched nothing.
  let gitSince: string | undefined
  // An unbraced path keeps its brackets: `./packages/[abc]` is a glob
  // class, and Turbo takes a directory with a ref only as `{dir}[ref]`.
  const scoped = /^(.+)\[([^\]]+)\]$/.exec(s)
  let sinceViaDeps = false
  if (scoped !== null && !scoped[1]!.startsWith('./') && scoped[1] !== '.') {
    s = scoped[1]!
    gitSince = scoped[2]!
    // The name glob kept the `...` and matched nothing (create-t3-turbo,
    // `@acme/*...[HEAD]`).
    if (s.endsWith('...') && !s.endsWith('^...')) {
      s = s.slice(0, -3)
      sinceViaDeps = true
    }
  }

  // `...`, `!`, `^...`: the operators with no project between them. An
  // empty name glob matched nothing and was hinted "Did you mean a?", and
  // an empty exclude (`!$UNSET`) excluded nothing, so every project ran
  // with one warning line (item 1030).
  if (s === '') throw new UserError(`filter "${raw}" names no project`)

  // `//` is Turbo's name for the root package (`--filter=//`, `//...`,
  // `!//`, probed on 2.8.17). vx names the root project by its
  // package.json name, so `//` is its directory, and only a project
  // there: read as `.`, it would select every project when the root is
  // none.
  if (s === '//') {
    return {
      raw,
      negate,
      withDeps,
      withDependents,
      onlyDeps,
      onlyDependents,
      isPath: true,
      matcher: path.resolve(workspaceRoot),
      exactDir: true,
      ...(gitSince !== undefined ? { gitSince } : {}),
      ...(sinceViaDeps ? { sinceViaDeps: true as const } : {}),
    }
  }

  if (s.startsWith('tag:')) {
    const tag = s.slice(4)
    if (tag === '') throw new UserError(`filter "${raw}" names no tag`)
    return {
      raw,
      negate,
      withDeps,
      withDependents,
      onlyDeps,
      onlyDependents,
      isPath: false,
      matcher: tag,
      tag: true,
      ...(gitSince !== undefined ? { gitSince } : {}),
      ...(sinceViaDeps ? { sinceViaDeps: true as const } : {}),
    }
  }

  let isPath = false
  let matcher = s
  let pathGlob: Bun.Glob | undefined
  let pathGlobBase: Bun.Glob | undefined
  const pathForm =
    s.startsWith('./') || s === '.'
      ? s
      : s.startsWith('{') && s.endsWith('}')
        ? s.slice(1, -1)
        : undefined
  if (pathForm !== undefined) {
    isPath = true
    matcher = path.resolve(workspaceRoot, pathForm)
    // `./packages/*` — pnpm's and Turbo's spelling for "every package under
    // packages": a glob over the root-relative project dir. Resolved
    // against the workspace root like the literal form.
    // A member glob, not a task glob: `Bun.Glob`'s alphabet, the class included.
    if (BUN_GLOB_WILDCARDS.test(pathForm)) {
      const rel = path.relative(workspaceRoot, matcher).split(path.sep).join('/')
      const glob = rel.replace(/\/+$/, '')
      pathGlob = new Bun.Glob(glob)
      if (glob.endsWith('/**')) pathGlobBase = new Bun.Glob(glob.slice(0, -3))
    }
  }

  // A package name holds a `/` only after its `@scope`, so `apps/*` is a
  // directory for every project named after its package.json; Nx matches
  // a `--projects` entry by name, then by root (find-matching-projects,
  // 23.2.1), and `-p 'apps/*'` matched nothing here.
  const dirFallback =
    !isPath && s.includes('/') && !s.startsWith('@')
      ? parseFilter(`./${s}`, workspaceRoot)
      : undefined

  return {
    raw,
    negate,
    withDeps,
    withDependents,
    onlyDeps,
    onlyDependents,
    isPath,
    matcher,
    ...(dirFallback !== undefined ? { dirFallback } : {}),
    ...(pathGlob !== undefined ? { pathGlob, pathRoot: workspaceRoot } : {}),
    ...(pathGlobBase !== undefined ? { pathGlobBase } : {}),
    ...(gitSince !== undefined ? { gitSince } : {}),
    ...(sinceViaDeps ? { sinceViaDeps: true as const } : {}),
  }
}

function matchProjects(
  filter: ParsedFilter,
  projects: ProjectMeta[],
  affectedByFilter: Map<ParsedFilter, Set<string>> | undefined,
  graph: PackageGraph,
  tags: ProjectTags | undefined,
): string[] {
  // `[<since>]` selectors are pre-resolved by the caller (the parser
  // is pure; git access happens upstream). Use the provided set as
  // the match set for this filter.
  if (filter.gitSince !== undefined) {
    let changed = affectedByFilter?.get(filter) ?? new Set<string>()
    if (filter.sinceViaDeps === true) {
      changed = new Set(changed)
      for (const name of [...changed])
        for (const d of graph.transitiveDependents(name)) changed.add(d)
    }
    if (filter.matcher === '') return [...changed]
    return matchSelector(filter, projects, tags).filter((name) => changed.has(name))
  }
  return matchSelector(filter, projects, tags)
}

/** The projects a name, path or tag selector names, git ranges aside. */
function matchSelector(
  filter: ParsedFilter,
  projects: ProjectMeta[],
  tags: ProjectTags | undefined,
): string[] {
  const out: string[] = []
  if (filter.tag === true) {
    const re = compileNameGlob(filter.matcher)
    for (const p of projects)
      if (tags?.get(p.name)?.some((t) => re.test(t)) === true) out.push(p.name)
    return out
  }
  if (filter.isPath) {
    // A path naming a project's own directory is that project, as Turbo and
    // pnpm read it: `.` is the root project, never every project under the
    // root, and `./packages/app` leaves the examples nested in it (D-43).
    // A directory that is no project keeps the "at or under" reading.
    const exact = projects.find((p) => p.dir === filter.matcher)
    if (exact !== undefined) return [exact.name]
    if (filter.exactDir === true) return out
    const prefix = filter.matcher + path.sep
    for (const p of projects) {
      if (p.dir.startsWith(prefix)) out.push(p.name)
    }
    // A path that names a project directory literally means that directory,
    // as git reads a pathspec, even when it holds glob characters
    // (`./packages/[abc]`); only a path that selects nothing literally is
    // read as a glob.
    if (out.length > 0) return out
    if (filter.pathGlob !== undefined) {
      // The glob is matched against the project's own dir, as pnpm and
      // Turbo do: `./packages/*` is the packages directly under `packages`,
      // `./packages/**` reaches the nested ones too, and `./packages/kit/**`
      // kit itself (kit's `check`: pnpm and Turbo read `**` as zero dirs too).
      for (const p of projects) {
        const rel = path
          .relative(filter.pathRoot ?? '', p.dir)
          .split(path.sep)
          .join('/')
        if (filter.pathGlob.match(rel) || filter.pathGlobBase?.match(rel) === true) out.push(p.name)
      }
    }
    return out
  }
  // A `*`-free name compiles to an exact anchored match, so a bare name
  // needs no branch of its own: the one this had was deleted with the
  // whole core suite green (item 649).
  const re = compileNameGlob(filter.matcher)
  for (const p of projects) {
    if (re.test(p.name)) out.push(p.name)
  }
  if (out.length === 0 && filter.dirFallback !== undefined)
    return matchSelector(filter.dirFallback, projects, tags)
  if (out.length > 0 || filter.matcher.includes('/')) return out
  // pnpm's rule: the scope may be left out (`--filter core` is
  // `@babel/core`), an exact name only when one package carries it. Nx
  // names `@nx-example/cart` `cart`, and `-p cart` matched nothing.
  for (const p of projects) {
    const slash = p.name.indexOf('/')
    if (p.name.startsWith('@') && re.test(p.name.slice(slash + 1))) out.push(p.name)
  }
  return filter.matcher.includes('*') || out.length === 1 ? out : []
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

/** Each project's config `tags`, by project name. */
type ProjectTags = ReadonlyMap<string, readonly string[]>

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /** Read by `tag:` selectors; a project absent here carries no tag. */
  tags?: ProjectTags
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
  /**
   * Called once per filter whose pattern matched projects but whose walk
   * selected none (`...^c` for a `c` nothing depends on), with what it
   * matched. Reported as a no-match, it read as a typo (item 1030).
   */
  onEmptyWalk?: (filter: ParsedFilter, matched: readonly string[]) => void
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string> {
  const allNames = opts.projects.map((p) => p.name)
  const hasInclude = opts.filters.some((f) => !f.negate)
  const selected = new Set<string>(hasInclude ? [] : allNames)

  // Every include before any exclude, as pnpm does: applied in argv order,
  // `--filter '!b' --filter 'a...'` let the later include add back what the
  // exclude had removed, and b ran (item 979). The expansions are still
  // taken in argv order, so `onNoMatch` names the filters as typed.
  const excludes: Set<string>[] = []
  for (const f of opts.filters) {
    const matched = matchProjects(f, opts.projects, opts.affectedByFilter, opts.graph, opts.tags)
    if (matched.length === 0) opts.onNoMatch?.(f)
    const expanded = new Set<string>()
    for (const name of matched) {
      if (!f.onlyDeps && !f.onlyDependents) expanded.add(name)
      if (f.withDeps || f.onlyDeps) {
        for (const d of opts.graph.transitiveDeps(name)) expanded.add(d)
      }
      if (f.withDependents) {
        // Both walks: the dependents' own dependencies too, as Turbo 2.5.8
        // selects (`...db...` on create-t3-turbo ran the ui and validators
        // its apps build on; vx ran db's dependencies alone).
        const both = f.withDeps || f.onlyDeps
        for (const d of opts.graph.transitiveDependents(name)) {
          expanded.add(d)
          if (both) for (const dd of opts.graph.transitiveDeps(d)) expanded.add(dd)
        }
      }
    }
    if (matched.length > 0 && expanded.size === 0) opts.onEmptyWalk?.(f, matched)
    if (f.negate) excludes.push(expanded)
    else for (const name of expanded) selected.add(name)
  }
  for (const expanded of excludes) for (const name of expanded) selected.delete(name)

  return selected
}
