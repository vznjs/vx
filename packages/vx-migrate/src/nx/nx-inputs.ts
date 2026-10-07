// An Nx target's `inputs` as vx's cache inputs. Named inputs expand from
// the project's scope (nx.json's merged under its own); a path's tokens
// interpolate as Nx's do, and it is a project glob when it lands in the
// project, else a workspace one; `{ env }` and
// `{ runtime }` map to their vx twins, `{ json }` to its whole file; `^x` is recorded for the mapper to
// resolve over the project graph (nx-upstream.ts). What vx folds through `dependsOn` already
// (`dependentTasksOutputFiles`) is nothing; `externalDependencies` is a todo saying
// so. Extracted from `buildTask` in item 606.

import { nxWorkspacePath, underProject } from './nx-outputs.js'
import { minimatchToVx } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'

export interface NxInputs {
  readonly files: string[]
  readonly wsFiles: string[]
  readonly envNames: string[]
  /**
   * Nx's `{ runtime: "<cmd>" }` hashes the command's output, run at the
   * WORKSPACE ROOT (`hash_runtime.rs`): `cache.inputs.workspaceRuntime`.
   * It was mapped to `runtime`, which runs in the project dir, so
   * `cat tools/version.txt` failed the run and a command that runs in both
   * hashed a different fact (item 913). It was once reported "not
   * representable in vx" (walked the Nx path, 2026-09-20).
   */
  readonly runtimeCmds: string[]
  /** `^name` / `{ input, dependencies | projects }`: whose `name` to fold. */
  readonly upstream: Array<{ readonly name: string; readonly of: 'deps' | readonly string[] }>
}

export function emptyNxInputs(): NxInputs {
  return { files: [], wsFiles: [], envNames: [], runtimeCmds: [], upstream: [] }
}

/** Expands `entries` into `into`; a gap is a line in `todos`. */
export function expandNxInputs(
  entries: readonly unknown[],
  named: Readonly<Record<string, unknown[]>>,
  at: {
    readonly rel: string
    readonly name: string
    readonly outputs?: readonly string[]
    /** The root package.json's dependency names: every task's key holds them. */
    readonly rootDeps?: ReadonlySet<string>
  },
  into: NxInputs,
  todos: string[],
): void {
  const expand = (entry: unknown, seen: Set<string>): void => {
    if (typeof entry === 'string') {
      let s = entry
      let neg = ''
      if (s.startsWith('!')) {
        neg = '!'
        s = s.slice(1)
      }
      if (s.startsWith('^')) {
        // vx folds each dependency's key through the dependsOn edges, so
        // taking a dependency input out (`!^prod`) has nothing to remove.
        if (neg !== '') return
        into.upstream.push({ name: s.slice(1), of: 'deps' })
        return
      }
      if (s.includes('{')) {
        // A token anywhere, as Nx interpolates it (item 912).
        const p = nxWorkspacePath(s, at.rel, at.name)
        if (p === null) {
          todos.push(`input ${JSON.stringify(entry)} uses a token vx does not support`)
          return
        }
        if (neg === '' && at.outputs?.some((o) => p === o || p.startsWith(`${o}/`))) {
          todos.push(
            `input ${JSON.stringify(entry)} is an output of the project's own targets: git does not ` +
              'list it, so vx cannot key on it — dropped; the task that writes it keys its dependants through dependsOn',
          )
          return
        }
        const g = minimatchToVx(p, neg !== '')
        if (g === null) {
          todos.push(`input ${JSON.stringify(entry)}: glob syntax vx cannot take — map manually`)
          return
        }
        // Nx globs a `{workspaceRoot}` path over every file of the
        // workspace, a vx project glob only over its project's own: on the
        // root project TanStack Query's `{workspaceRoot}/**/package.json`
        // (sherif's input) left every package's manifest out of the key.
        const own =
          (at.rel === '' || at.rel === '.') && s.startsWith('{workspaceRoot}')
            ? null
            : underProject(g, at.rel)
        if (own === null) into.wsFiles.push(neg + g)
        else into.files.push(neg + own)
        return
      }
      // Bare string = named-input reference.
      const members = named[s]
      if (members === undefined) {
        // Over-keyed, never under: an empty input list keyed a cached task
        // on its config alone, a stale hit after every source edit (an
        // nx.json `extends` preset not installed where the snapshot is read).
        if (neg === '') into.files.push('**/*')
        todos.push(
          `named input ${JSON.stringify(s)} not found in nx.json or the project — keyed on the whole project (\`**/*\`) until its globs are declared`,
        )
        return
      }
      if (seen.has(s)) return
      seen.add(s)
      for (const e of members) expand(e, seen)
      return
    }
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>
      if (typeof o.env === 'string') {
        into.envNames.push(o.env)
        return
      }
      if (typeof o.runtime === 'string') {
        into.runtimeCmds.push(o.runtime)
        return
      }
      if (typeof o.fileset === 'string' && o.includeIgnored === true) {
        ignored(entry, o.fileset, o.dependencies === true)
        return
      }
      if (typeof o.fileset === 'string') {
        // `dependencies: true` is each dependency's fileset, as `^{projectRoot}/…`
        // is. Expanded as the project's own, a dependency's edit re-keyed
        // nothing here (nx-examples' inferred `typecheck` carries both).
        if (o.dependencies === true) into.upstream.push({ name: o.fileset, of: 'deps' })
        else expand(o.fileset, seen)
        return
      }
      if (typeof o.json === 'string') {
        // `{ json, fields }` hashes only those fields; the whole file is a
        // superset. Reported and dropped, a `compilerOptions` edit to the
        // root tsconfig.json was a hit where Nx re-ran (@nx/vitest infers
        // it, 2026-09-28).
        expand(o.json.includes('{') ? o.json : `{workspaceRoot}/${o.json}`, seen)
        return
      }
      if (o.externalDependencies !== undefined) {
        // Not the project's package.json: Nx's inferred targets name root
        // devDependencies (eslint, vitest), which only the lockfile keys.
        // One the root declares is keyed already, with or without a
        // lockfile plugin (it keys the root's dependencies): nothing to
        // say. The todo sat on 32 tasks of analogjs for `eslint`.
        const names = Array.isArray(o.externalDependencies) ? o.externalDependencies : []
        if (names.length > 0 && names.every((n) => typeof n === 'string' && at.rootDeps?.has(n)))
          return
        todos.push(
          `input {externalDependencies: ${JSON.stringify(o.externalDependencies)}}: vx keys ` +
            'every task on the lockfile (the whole file, or with a @vzn/vx-lockfile plugin the ' +
            "project's and the root's dependencies) — safe to drop unless only another project installs one",
        )
        return
      }
      // Nx hashes the outputs of the tasks this one depends on; vx folds
      // those tasks' keys (their inputs, transitively) through `dependsOn`,
      // and an output follows from its inputs. Nothing to map, and the todo
      // it was sat on 881 tasks of three real Nx repos (G-49).
      if (o.dependentTasksOutputFiles !== undefined) return
      // `{ workingDirectory }` hashes where Nx was started (`cwd:relative`
      // in its plan). A vx task runs in its project dir from wherever vx
      // is started, so the fact is the same for every run: nothing to key.
      if (o.workingDirectory === 'relative' || o.workingDirectory === 'absolute') return
      if (typeof o.input === 'string') {
        // Nx 23 still reads the pre-17 spellings `projects: "dependencies"`
        // (`^input`) and `projects: "self"` (the project's own); taken as
        // project names, each was a todo and the input was dropped.
        if (o.dependencies === true || o.projects === 'dependencies') {
          into.upstream.push({ name: o.input, of: 'deps' })
          return
        }
        if (o.projects !== undefined && o.projects !== 'self') {
          const of = typeof o.projects === 'string' ? [o.projects] : o.projects
          if (!Array.isArray(of) || !of.every((p) => typeof p === 'string')) {
            todos.push(`input ${JSON.stringify(entry)} not representable in vx`)
            return
          }
          into.upstream.push({ name: o.input, of: of as string[] })
          return
        }
        expand(o.input, seen)
        return
      }
    }
    todos.push(`input ${JSON.stringify(entry)} not representable in vx`)
  }
  // `{ fileset, includeIgnored: true }` (Nx 23) hashes the path from disk,
  // gitignored or generated, a missing one included. vx's globs see only
  // what git lists: mapped as one, a gitignored literal failed the task
  // before it ran. A literal path is read by a probe at the workspace root
  // instead, its exit telling a missing file from an empty one.
  const ignored = (entry: unknown, fileset: string, deps: boolean): void => {
    const neg = fileset.startsWith('!')
    const p = nxWorkspacePath(neg ? fileset.slice(1) : fileset, at.rel, at.name)
    if (deps || p === null || /[*?[{]/.test(p)) {
      todos.push(
        `input ${JSON.stringify(entry)}: vx keys only the files git lists, so a gitignored ` +
          'match is not in the key — read it with a cache.inputs.workspaceRuntime probe',
      )
      return
    }
    // A negation filters only other includeIgnored matches, and a literal
    // reads no others.
    if (!neg) into.runtimeCmds.push(`cat -- ${shellQuote(p)} 2>/dev/null; echo "$?"`)
  }
  for (const entry of entries) expand(entry, new Set())
  // Nx matches a project fileset with no positive glob against every project
  // file, the negations taken out: nx-recipes' `noMarkdown` is
  // `["!{projectRoot}/**/*.md"]`, and a `.tsx` edit re-runs its build while a
  // `.md` edit hits (nx 17.1.3, 2026-10-01). Mapped as written, core refused
  // the negation-only list and no task of the workspace ran.
  if (into.files.length > 0 && into.files.every((f) => f.startsWith('!')))
    into.files.unshift('**/*')
}
