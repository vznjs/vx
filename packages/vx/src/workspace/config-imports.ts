// The third `changed file → project` channel for `--affected`.
//
// Directory containment answers "which project owns this file", and
// `cache.inputs.workspaceFiles` answers "which project declared it". Neither
// can see the one remaining way a file reaches a task: a project's
// `vx.config.*` IMPORTS it. Resolved-config hashing folds the imported values
// into the cache key (architecture principle #4), so editing such a file
// re-keys the task — and `affected.ts` states the rule this exists to keep:
// "input hashing sees it, so `--affected` must too."
//
// This is a STATIC scan. Nothing is evaluated: `Bun.Transpiler.scanImports`
// reads the specifiers and `Bun.resolveSync` turns them into paths. The
// `project-loader.ts` note that a bust "cannot reach the config's import
// closure" is about `import()` at runtime, not about reading the source.
//
// Two rules keep the walk small, and the second is the one that makes it
// affordable at all:
//
//   - RELATIVE specifiers only. A bare specifier is a package; it moves when
//     the lockfile moves, which the workspace fingerprint already covers.
//   - Descend only through files owned by NO project. A config reaching into
//     another project (this repo's `apps/docs/vx.config.ts` imports
//     `../../src/index.ts`) records that edge and STOPS there — following it
//     would drag substantially all of core `src/` into the closure, and the
//     containment channel already selects the project that owns it.

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectMeta } from './workspace.js'

/**
 * Absolute resolved targets of the RELATIVE specifiers in `source`.
 *
 * Paths come back realpath'd, because `Bun.resolveSync` realpaths them — see
 * the caller, which realpaths everything it compares against for exactly that
 * reason. `import type` is erased by `scanImports` and so contributes no edge,
 * which is correct: an erased import cannot move a resolved value.
 */
function scanLocalImports(source: string, fromDir: string, loader: 'ts' | 'js'): string[] {
  let specifiers: string[]
  try {
    specifiers = new Bun.Transpiler({ loader }).scanImports(source).map((i) => i.path)
  } catch {
    return [] // unparseable source contributes no edges
  }
  const out: string[] = []
  for (const spec of specifiers) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue
    try {
      out.push(Bun.resolveSync(spec, fromDir))
    } catch {
      // Unresolvable (deleted, typo, extensionless miss) — a config that will
      // not load cannot be shown to import anything, and failing selection
      // over it would break a working build.
    }
  }
  return out
}

export interface ConfigImportOwnersArgs {
  /**
   * Realpath'd HERE, not by the caller. `Bun.resolveSync` returns realpath'd
   * targets, so a raw root silently fails every containment check and the
   * scan reports "no imports" — indistinguishable from a clean tree. Owning
   * the normalisation in one place makes that misuse unrepresentable.
   */
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  /** Workspace-relative POSIX paths — the same list containment consumed. */
  changed: readonly string[]
  /** Already-selected projects; their configs need no scan. */
  skip: ReadonlySet<string>
}

/**
 * Project dir → name, REALPATH'D — which is why this cannot reuse the index
 * the containment pass builds. `Bun.resolveSync` hands back realpath'd
 * targets, and on darwin a workspace under `os.tmpdir()` lives at
 * `/var/folders/…` while its realpath is `/private/var/folders/…`; comparing
 * the two matches nothing and fails exactly like "found no imports".
 */
async function realDirIndex(projects: readonly ProjectMeta[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    projects.map(async (p) => {
      out.set(await realpath(p.dir).catch(() => p.dir), p.name)
    }),
  )
  return out
}

const TS_EXT = new Set(['.ts', '.mts', '.cts'])

/** The deepest project containing `file`, or undefined when none does. */
function ownerOf(file: string, dirToName: ReadonlyMap<string, string>): string | undefined {
  let dir = path.dirname(file)
  for (;;) {
    const name = dirToName.get(dir)
    if (name !== undefined) return name
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Projects whose config file transitively imports one of `changed`. */
export async function configImportOwners(a: ConfigImportOwnersArgs): Promise<Set<string>> {
  const selected = new Set<string>()
  if (a.changed.length === 0 || a.skip.size === a.projects.length) return selected
  const workspaceRoot = await realpath(a.workspaceRoot).catch(() => a.workspaceRoot)

  const roots = new Map<string, string>() // abs config path → project name
  await Promise.all(
    a.projects.map(async (p) => {
      const cfg = p.configPath
      if (cfg === null || cfg === '' || a.skip.has(p.name)) return
      roots.set(await realpath(cfg).catch(() => path.resolve(cfg)), p.name)
    }),
  )
  if (roots.size === 0) return selected
  const dirToName = await realDirIndex(a.projects)

  // target → the files that import it. Reversed up front so one BFS from the
  // changed set answers every root at once, instead of a walk per root.
  const importedBy = new Map<string, string[]>()
  const visited = new Set<string>()
  const queue = [...roots.keys()]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    let source: string
    try {
      source = await Bun.file(file).text()
    } catch {
      continue // unreadable: no edges, and not this pass's problem to report
    }
    const loader = TS_EXT.has(path.extname(file)) ? 'ts' : 'js'
    for (const target of scanLocalImports(source, path.dirname(file), loader)) {
      if (!target.startsWith(workspaceRoot + path.sep)) continue
      if (target.split(path.sep).includes('node_modules')) continue
      const list = importedBy.get(target)
      if (list) list.push(file)
      else importedBy.set(target, [file])
      // Descend ONLY through unowned files — see the header.
      if (ownerOf(target, dirToName) === undefined) queue.push(target)
    }
  }

  const seen = new Set<string>()
  const walk = [...a.changed.map((rel) => path.resolve(workspaceRoot, rel))]
  while (walk.length > 0) {
    const file = walk.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const owner = roots.get(file)
    if (owner !== undefined) selected.add(owner)
    for (const importer of importedBy.get(file) ?? []) walk.push(importer)
  }
  return selected
}
