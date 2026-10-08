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
