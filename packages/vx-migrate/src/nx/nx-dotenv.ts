// Which `.env` files Nx loads for a task: `getEnvPathsForTask`
// (tasks-runner/task-env-paths.ts) and `getOwnerTargetForTask`
// (task-env.ts), the same in Nx 22.7 and 23.2. The project's own files come
// before the workspace root's, the most specific name first
// (`.env.build.production.local` … `.env`), and the first file to define a
// name wins. The mapper keeps the ones that EXIST, from one directory
// listing per project per run, so a task with none costs nothing at run
// time; the bins load them (`nx-dotenv.cjs`).

import { readdir } from 'node:fs/promises'
import path from 'node:path'

/** A target's `metadata`, as far as the owner-target rule reads it. */
interface TargetMeta {
  readonly metadata?: { readonly nonAtomizedTarget?: unknown }
}

/** `.env` file names per directory (workspace-relative, `.` for the root). */
export type DotenvListing = ReadonlyMap<string, ReadonlySet<string>>

function variants(identifier: string, root: string | undefined): string[] {
  const p = root ? `${root}/` : ''
  if (identifier) {
    return [
      `${p}.env.${identifier}.local`,
      `${p}.env.${identifier}`,
      `${p}.${identifier}.local.env`,
      `${p}.${identifier}.env`,
    ]
  }
  return [`${p}.env.local`, `${p}.local.env`, `${p}.env`]
}

/** Nx's candidate list, workspace-relative, in load order. */
export function dotenvCandidates(
  projectRoot: string,
  target: string,
  configuration: string | undefined,
  nonAtomizedTarget: string | undefined,
): string[] {
  const ids: string[] = []
  if (configuration) {
    ids.push(`${target}.${configuration}`)
    if (nonAtomizedTarget) ids.push(`${nonAtomizedTarget}.${configuration}`)
    ids.push(configuration)
  }
  ids.push(target)
  if (nonAtomizedTarget) ids.push(nonAtomizedTarget)
  ids.push('')
  return [
    ...ids.flatMap((id) => variants(id, projectRoot)),
    ...ids.flatMap((id) => variants(id, undefined)),
  ]
}

/**
 * An atomized target (`e2e-ci--src/a.cy.ts`) loads its parent's files too:
 * Nx finds the parent through the project's `targetGroups`.
 */
export function nonAtomizedTargetOf(
  target: string,
  targets: Readonly<Record<string, TargetMeta>>,
  targetGroups: unknown,
): string | undefined {
  if (typeof targetGroups !== 'object' || targetGroups === null) return undefined
  for (const group of Object.values(targetGroups as Record<string, unknown>)) {
    if (!Array.isArray(group) || !group.includes(target)) continue
    for (const t of group) {
      const parent = typeof t === 'string' ? targets[t]?.metadata?.nonAtomizedTarget : undefined
      if (typeof parent === 'string' && parent.length > 0) return parent
    }
  }
  return undefined
}

/** Could `name` be one of Nx's `.env` variants? */
function isDotenvName(name: string): boolean {
  return name.startsWith('.env') || (name.startsWith('.') && name.endsWith('.env'))
}

/** One listing of each directory, the `.env`-shaped names only. */
export async function listDotenv(root: string, dirs: readonly string[]): Promise<DotenvListing> {
  const unique = [...new Set(['.', ...dirs])]
  const lists = await Promise.all(
    unique.map((d) =>
      readdir(path.join(root, d)).then(
        (names) => new Set(names.filter(isDotenvName)),
        () => new Set<string>(),
      ),
    ),
  )
  return new Map(unique.map((d, i) => [d, lists[i]!]))
}

/** The candidates that exist, workspace-relative, in load order. */
export function existingDotenv(candidates: readonly string[], listing: DotenvListing): string[] {
  return candidates.filter((c) => {
    const slash = c.lastIndexOf('/')
    const dir = slash === -1 ? '.' : c.slice(0, slash)
    return listing.get(dir === '' ? '.' : dir)?.has(c.slice(slash + 1)) === true
  })
}
