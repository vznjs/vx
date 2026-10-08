// An Nx target's `dependsOn` as vx edges. Nx separates a specific
// project's target with a COLON (`ui:build`); vx's separator is `#`.
// Passed through, the string form read as a task named `ui:build` in the
// DEPENDENT's own project and the migrated workspace refused to run —
// "depends on web#ui:build but no such task is declared", from a config
// vx-migrate itself wrote (walked the Nx path, 2026-09-20). Extracted from
// `buildTask` in item 606; the rules are unchanged.

import type { ProjectMeta } from '@vzn/vx'

/** The vx task an Nx `project:target:configuration` reaches, or null when the target lacks it. */
export type TaskNameFor = (project: string, target: string, configuration: string) => string | null

/**
 * Nx adds an edge to a project's target only when the project HAS that
 * target (`processTasksForSingleProject`), and says nothing otherwise:
 * nx-examples' `targetDefaults` give every `typecheck` a `codegen` that
 * one project declares. Passed through, core refused the whole run —
 * "depends on …#codegen but no such task is declared". Dropped here as
 * Nx drops it, for this project and a named one alike.
 */
type HasTarget = (project: string, target: string) => boolean

/**
 * The graph nodes a `projects` list names, ported from Nx's
 * `findMatchingProjects` (nx 23.2): a `name:`, `tag:` or `directory:`
 * label, or none, which tries the name and then the project's root
 * directory; minimatch globs (`dot`); a bare word that names no project
 * matches names it stands in as a word, case-insensitive (`foo` is
 * `foo_bar`, not `foo-e2e`); `!` excludes, and a list that opens with an
 * exclusion starts from every node. vx read names and `*` alone, so
 * `libs/shared/*` (a directory) matched nothing and its edge or input
 * was dropped.
 */
export function matchNxProjects(
  patterns: readonly string[],
  nodes: ReadonlyArray<{
    readonly name: string
    readonly tags: readonly string[]
    readonly root?: string
  }>,
): string[] {
  if (patterns.every((p) => p.length === 0)) return []
  const byName = new Map(nodes.map((n) => [n.name, n]))
  const glob = (p: string, s: string): boolean => s === p || new Bun.Glob(p).match(s)
  const out = new Set<string>()
  const list = patterns[0]!.startsWith('!') ? ['*', ...patterns] : patterns
  for (const raw of list) {
    if (raw.length === 0 || raw.startsWith('nx-cloud:')) continue
    const exclude = raw.startsWith('!')
    let value = exclude ? raw.slice(1) : raw
    let type = 'unlabeled'
    if (byName.has(value)) type = 'name'
    else if (value.includes(':')) {
      // Nx drops the head whether or not it is a label it knows.
      const head = value.slice(0, value.indexOf(':'))
      if (['name', 'tag', 'directory'].includes(head)) type = head
      value = value.slice(value.indexOf(':') + 1)
    }
    const put = (name: string): void => {
      if (exclude) out.delete(name)
      else out.add(name)
    }
    if (value === '*') {
      for (const n of nodes) put(n.name)
      continue
    }
    const pattern = TARGET_GLOB.test(value)
    const byNames = (): void => {
      if (byName.has(value)) return put(value)
      if (!pattern) {
        const word = new RegExp(`(?<![@a-zA-Z0-9-])${value}(?![@a-zA-Z0-9-])`, 'i')
        for (const n of nodes) if (word.test(n.name)) put(n.name)
        return
      }
      for (const n of nodes) if (glob(value, n.name)) put(n.name)
    }
    const byDirectory = (): void => {
      for (const n of nodes) if (n.root !== undefined && glob(value, n.root)) put(n.name)
    }
    if (type === 'tag') {
      for (const n of nodes)
        if (n.tags.includes(value) || (pattern && n.tags.some((t) => glob(value, t)))) put(n.name)
    } else if (type === 'name') byNames()
    else if (type === 'directory') byDirectory()
    else {
      const size = out.size
      byNames()
      if (out.size === size) byDirectory()
    }
  }
  return [...out]
}

/** Nx's `isGlobPattern`: a target holding one of these is a pattern. */
const TARGET_GLOB = /[*|{}()[]/

/**
 * Nx (19.5+) expands a target glob in `dependsOn` over every target name
 * in the workspace (`expandWildcardTargetConfiguration`), after reading a
 * `project:` head, and keeps the edge where the project has the target.
 * Read as `project:target`, TanStack/router's `test:e2e--*` named project
 * `test` and each of 140 aggregators lost the modes it fans out to
 * (2026-09-28).
 */
function expandTargetGlobs(
  entries: readonly unknown[],
  targetNames: readonly string[],
  isProject: (name: string) => boolean,
  ownTarget: (name: string) => boolean,
): unknown[] {
  const expand = (pattern: string): string[] => {
    const glob = new Bun.Glob(pattern)
    return targetNames.filter((t) => glob.match(t))
  }
  // A glob's match another entry names already is that entry's edge (`^bui*` beside `^build`).
  const literal = new Set(entries.filter((d) => typeof d === 'string'))
  const fresh = (ds: string[]): string[] => ds.filter((d) => !literal.has(d))
  return entries.flatMap((d): unknown[] => {
    if (typeof d === 'string') {
      if (!TARGET_GLOB.test(d)) return [d]
      if (d.startsWith('^')) return fresh(expand(d.slice(1)).map((t) => `^${t}`))
      const colon = d.indexOf(':')
      const head = colon > 0 ? d.slice(0, colon) : ''
      if (head !== '' && isProject(head)) {
        return fresh(expand(d.slice(colon + 1)).map((t) => `${head}:${t}`))
      }
      // A same-project glob keeps only this project's targets: a match
      // another project declares (`test:e2e--webkit`) read as project
      // `test` and drew a dropped-edge todo per aggregator (TanStack/router).
      return fresh(expand(d).filter(ownTarget))
    }
    if (d && typeof d === 'object') {
      const t = (d as Record<string, unknown>).target
      if (typeof t === 'string' && TARGET_GLOB.test(t)) {
        return expand(t).map((target) => ({ ...(d as Record<string, unknown>), target }))
      }
    }
    return [d]
  })
}

export function mapNxDeps(
  raw: readonly unknown[],
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  ownTarget: (name: string) => boolean,
  taskNameFor: TaskNameFor,
  hasTarget: HasTarget,
  todos: string[],
  matchProjects: (patterns: readonly string[]) => string[] = (ps) => [...ps],
  targetNames: readonly string[] = [],
  asked?: { readonly node: string; readonly configuration: string },
  /** This target's options, its configuration's merged in: what `options: "forward"` hands on. */
  forwarded?: Readonly<Record<string, unknown>>,
): string[] {
  const entries = expandTargetGlobs(raw, targetNames, (p) => metaByNode.has(p), ownTarget)
  const deps: string[] = []
  // Said once per task and without the dependency's name: cypress's
  // atomized `e2e-ci` forwards params to each spec's task, and a line
  // per spec name was a warning line per spec on every run.
  const forwards = { options: false, params: false }
  // Nx hands every edge the configuration the run asked for, and each
  // target runs it where it declares it, else its default
  // (`resolveConfiguration`). `build:ci`'s `lint` ran lint's default.
  const named = (project: string, t: string): string =>
    (asked && taskNameFor(project, t, asked.configuration)) ?? t
  const self = asked?.node ?? ''
  for (const d of entries) {
    if (typeof d === 'string') {
      // `^name` is every dependency's `name`, whatever the name holds: the
      // colon in `^rsbuild:typecheck` (an inferred target) is the target's
      // own, and splitting there read project `^rsbuild`, which no graph
      // has, and dropped the edge.
      if (d.startsWith('^')) {
        deps.push(d)
        continue
      }
      const colon = d.indexOf(':')
      if (colon <= 0) {
        if (ownTarget(d)) deps.push(named(self, d))
        continue
      }
      const project = d.slice(0, colon)
      const rest = d.slice(colon + 1)
      const m = metaByNode.get(project)
      // Nx splits at the colon only when the head names a project; else
      // the whole string is a target of this project (`test:unit`, as
      // script-inferred targets are named). It was read as project `test`
      // and the edge dropped (item 915). This project's own target ranks
      // first (`splitTargetFromNodes`).
      if (ownTarget(d)) {
        deps.push(named(self, d))
        continue
      }
      if (m === undefined || rest === '') {
        todos.push(
          `dependsOn ${JSON.stringify(d)} names ${JSON.stringify(project)}, which is not a ` +
            'workspace package in this graph — edge dropped',
        )
        continue
      }
      // The rest is ONE target name, colons and all, as Nx's
      // `readProjectAndTargetFromTargetString` joins it: `ui:build:esm` is
      // ui's `build:esm`, and `ui:build:ci` names target `build:ci`, never
      // build's `ci` configuration (the run's configuration is what an edge
      // passes on). Nx draws no edge where ui has no such target; vx sent
      // one to the configuration's task, or to `build` with a todo.
      if (hasTarget(project, rest)) deps.push(`${m.name}#${named(project, rest)}`)
      continue
    }
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>
      const t = typeof o.target === 'string' ? o.target : undefined
      if (t === undefined) {
        todos.push(`dependsOn ${JSON.stringify(d)} has no target — dropped`)
        continue
      }
      // `options: "forward"` hands the dependency this target's options as
      // overrides (`createTaskOverrides`): a different command, which vx's
      // one task per target cannot be. Nothing to hand on, nothing to say
      // (cypress's atomized `e2e-ci` forwards its empty options).
      if (o.options === 'forward' && forwarded !== undefined && Object.keys(forwarded).length > 0)
        forwards.options = true
      // `ignore` is Nx's default; only `forward` asks for something vx lacks.
      if (o.params === 'forward') forwards.params = true
      const raw = o.projects ?? (o.dependencies === true ? 'dependencies' : undefined)
      // Nx reads a lone string as a one-entry list (`projects: "b"`); it
      // was not representable here, and the edge dropped (item 1053).
      const projects =
        typeof raw === 'string' && raw !== 'self' && raw !== 'dependencies' ? [raw] : raw
      if (projects === undefined || projects === 'self') {
        if (ownTarget(t)) deps.push(named(self, t))
      } else if (projects === 'dependencies') deps.push(`^${t}`)
      else if (Array.isArray(projects) && projects.every((p) => typeof p === 'string')) {
        // Patterns and tags (`lib-*`, `tag:lib`) name the graph's nodes;
        // only an exact name that is no package is worth a line.
        for (const node of matchProjects(projects)) {
          const m = metaByNode.get(node)
          if (m && hasTarget(node, t)) deps.push(`${m.name}#${named(node, t)}`)
        }
        // A pattern, or a word or directory Nx matches, is no name to report.
        for (const p of projects) {
          if (
            /^!|^tag:|\*/.test(p) ||
            metaByNode.has(p) ||
            matchProjects([p]).some((n) => metaByNode.has(n))
          )
            continue
          todos.push(
            `dependsOn project ${JSON.stringify(p)} is not a workspace package — edge dropped`,
          )
        }
      } else todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
      continue
    }
    todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
  }
  if (forwards.options) {
    todos.push(
      'dependsOn `options: "forward"` is not supported — the dependency runs with its own ' +
        "options, not this target's",
    )
  }
  if (forwards.params) {
    todos.push(
      'dependsOn `params: "forward"` is not supported — forward args via `vx run … -- args` instead',
    )
  }
  // One edge spelled twice (`ui:gen` and `{ projects: ["ui"], target: "gen" }`)
  // is one dependency; the written config listed it twice.
  return [...new Set(deps)]
}
