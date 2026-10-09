export type Json = Record<string, unknown>

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

export function depsOf(
  e: Json,
  fields: readonly string[] = DEP_FIELDS,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const field of fields) {
    const deps = record(e[field])
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  }
  return out
}

export function record(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/**
 * The `dropped` names a manifest (or a lockfile's record of one) names
 * ONLY as devDependencies: an entry another field also holds is installed
 * in production and stays.
 */
export function devOnly(manifest: Json | undefined, dropped: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  const dev = record(manifest?.['devDependencies'])
  if (dev === undefined || dropped.size === 0) return out
  const elsewhere = depsOf(manifest!, ['dependencies', 'optionalDependencies', 'peerDependencies'])
  for (const name of Object.keys(dev)) if (dropped.has(name) && !elsewhere.has(name)) out.add(name)
  return out
}

/** `manifest`'s devDependencies without `names`; the field goes when nothing is left. */
export function dropDev(manifest: Json | undefined, names: ReadonlySet<string>): void {
  const dev = record(manifest?.['devDependencies'])
  if (manifest === undefined || dev === undefined || names.size === 0) return
  for (const name of names) delete dev[name]
  if (Object.keys(dev).length === 0) delete manifest['devDependencies']
}
