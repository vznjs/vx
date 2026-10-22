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

/** The `peerDependencies` names an entry installs under no other field. */
export function peerOnly(e: Json): ReadonlySet<string> {
  const installed = depsOf(e, DEP_FIELDS.slice(0, 3))
  return new Set(Object.keys(record(e['peerDependencies']) ?? {}).filter((n) => !installed.has(n)))
}

export function record(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/** JSON with sorted keys, so YAML key order cannot move a digest. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Json).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  )
}
