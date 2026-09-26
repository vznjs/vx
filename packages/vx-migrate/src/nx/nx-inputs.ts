// An Nx target's `inputs` as vx's cache inputs. Named inputs expand from
// the project's scope (nx.json's merged under its own); a path's tokens
// interpolate as Nx's do, and it is a project glob when it lands in the
// project, else a workspace one; `{ env }` and
// `{ runtime }` map to their vx twins; `^x` is recorded for the mapper to
// resolve over the project graph (nx-upstream.ts). What vx folds through `dependsOn` already
// (`dependentTasksOutputFiles`, `externalDependencies`) is a todo saying
// so. Extracted from `buildTask` in item 606.

import { nxWorkspacePath, underProject } from './nx-outputs.js'

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

const EXTGLOB = /([?@+*!])\(([^()]*)\)/g

/**
 * An Nx (minimatch) glob in vx's grammar, or null when it has no safe
 * form. vx has no character classes (a bracket is a literal, for route
 * dirs, item 667) and no extglobs, so `src/**\/*.[jt]s` matched nothing
 * and Nx's own default `production` negation,
 * `?(*.)+(spec|test).[jt]s?(x)`, excluded nothing (item 914):
 * - `[jt]` is the brace set `{j,t}`, plus the literal `[jt]` itself in a
 *   positive glob (a superset of inputs is safe; the route dir may be
 *   meant);
 * - `?(a|b)` is `{a,b,}` and `@(a|b)` is `{a,b}`;
 * - `+(a|b)` and `*(a|b)` narrow to one repetition, which only a
 *   NEGATION may do — it then excludes fewer files, never more;
 * - a range or negated class, `!(…)`, or nesting is null.
 */
function nxGlob(glob: string, negated: boolean): string | null {
  if (!/[[(]/.test(glob)) return glob
  let out = glob.replace(EXTGLOB, (whole, kind: string, body: string) => {
    const alts = body.split('|')
    if (alts.some((a) => /[{},]/.test(a))) return '\0'
    if (kind === '?') return `{${alts.join(',')},}`
    if (kind === '@') return `{${alts.join(',')}}`
    if (!negated || kind === '!') return '\0'
    return kind === '+' ? `{${alts.join(',')}}` : `{${alts.join(',')},}`
  })
  if (out.includes('\0') || /[?@+*!]\(/.test(out)) return null
  out = out.replace(/\[([^\]]*)\]/g, (whole, body: string) => {
    if (body === '' || /^[!^]/.test(body) || body.includes('-') || /[{},/]/.test(body)) return '\0'
    const chars = [...new Set(body)]
    return negated ? `{${chars.join(',')}}` : `{${whole},${chars.join(',')}}`
  })
  return out.includes('\0') ? null : out
}

/** Expands `entries` into `into`; a gap is a line in `todos`. */
export function expandNxInputs(
  entries: readonly unknown[],
  named: Readonly<Record<string, unknown[]>>,
  at: { readonly rel: string; readonly name: string },
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
        if (neg !== '') {
          todos.push(`input ${JSON.stringify(entry)}: a negated dependency input — map manually`)
          return
        }
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
        const g = nxGlob(p, neg !== '')
        if (g === null) {
          todos.push(`input ${JSON.stringify(entry)}: glob syntax vx cannot take — map manually`)
          return
        }
        const own = underProject(g, at.rel)
        if (own === null) into.wsFiles.push(neg + g)
        else into.files.push(neg + own)
        return
      }
      // Bare string = named-input reference.
      const members = named[s]
      if (members === undefined) {
        todos.push(
          `named input ${JSON.stringify(s)} not found in nx.json or the project — declare its globs manually`,
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
      if (typeof o.fileset === 'string') {
        expand(o.fileset, seen)
        return
      }
      if (o.externalDependencies !== undefined) {
        todos.push(
          `input {externalDependencies: ${JSON.stringify(o.externalDependencies)}}: vx hashes ` +
            "the project's package.json into every key — usually safe to drop",
        )
        return
      }
      if (o.dependentTasksOutputFiles !== undefined) {
        todos.push(
          "input {dependentTasksOutputFiles: …}: vx already folds each dependency's cache key " +
            '(its inputs, never its outputs) through dependsOn — a change upstream is a key change here',
        )
        return
      }
      if (typeof o.input === 'string') {
        if (o.dependencies === true) {
          into.upstream.push({ name: o.input, of: 'deps' })
          return
        }
        if (o.projects !== undefined) {
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
  for (const entry of entries) expand(entry, new Set())
}
