// An Nx target's `inputs` as vx's cache inputs. Named inputs expand from
// the project's scope (nx.json's merged under its own); `{projectRoot}/…`
// is a project glob, `{workspaceRoot}/…` a workspace one; `{ env }` and
// `{ runtime }` map to their vx twins; `^x` is recorded for the mapper to
// resolve over the project graph (nx-upstream.ts). What vx folds through `dependsOn` already
// (`dependentTasksOutputFiles`, `externalDependencies`) is a todo saying
// so. Extracted from `buildTask` in item 606.

export interface NxInputs {
  readonly files: string[]
  readonly wsFiles: string[]
  readonly envNames: string[]
  /**
   * Nx's `{ runtime: "<cmd>" }` hashes the command's output, which is
   * exactly `cache.inputs.runtime` — schema.md calls it "the Nx `runtime`
   * input equivalent". It was reaching the fall-through and being reported
   * as "not representable in vx" (walked the Nx path, 2026-09-20).
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
      if (s.startsWith('{projectRoot}/')) {
        into.files.push(neg + s.slice('{projectRoot}/'.length))
        return
      }
      if (s.startsWith('{workspaceRoot}/')) {
        into.wsFiles.push(neg + s.slice('{workspaceRoot}/'.length))
        return
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
        todos.push(`input ${JSON.stringify(entry)} uses a token vx does not support`)
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
