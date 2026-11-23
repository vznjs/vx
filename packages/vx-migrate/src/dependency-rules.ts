// `run.rules.dependencies` as a migration writes it: Nx's
// `@nx/enforce-module-boundaries` and Turbo's `boundaries` both land here.
import { quoteTsLiteral } from '@vzn/vx'

/** `run.rules.dependencies`' entry, as core takes it. */
export interface DependencyRule {
  from: string
  allow?: string[]
  deny?: string[]
}

/** `{ dependencies: [...] }` as TypeScript source, for `run.rules`. */
export function rulesSource(rules: readonly DependencyRule[]): string {
  const list = (xs: readonly string[]) => `[${xs.map(quoteTsLiteral).join(', ')}]`
  const one = (r: DependencyRule) =>
    [
      `from: ${quoteTsLiteral(r.from)}`,
      ...(r.allow !== undefined ? [`allow: ${list(r.allow)}`] : []),
      ...(r.deny !== undefined ? [`deny: ${list(r.deny)}`] : []),
    ].join(', ')
  return `{ dependencies: [${rules.map((r) => `{ ${one(r)} }`).join(', ')}] }`
}

/**
 * turbo.json's `boundaries.tags` as vx rules. `dependencies` is the tag's
 * own rule; a `dependents.deny` is each named tag's deny of this one. A
 * `dependents.allow` (only these tags may depend on it) has no vx form:
 * vx names what a project may depend on, and an untagged project is free.
 */
export function turboBoundaryRules(raw: unknown): { rules: DependencyRule[]; gaps: string[] } {
  const rules: DependencyRule[] = []
  const gaps: string[] = []
  const tags = (raw as { boundaries?: { tags?: unknown } } | null)?.boundaries?.tags
  if (tags === null || typeof tags !== 'object') return { rules, gaps }
  const names = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t !== '') : undefined
  const sel = (t: string) => `tag:${t}`
  for (const [tag, rule] of Object.entries(tags as Record<string, unknown>)) {
    const r = (rule ?? {}) as { dependencies?: unknown; dependents?: unknown }
    const deps = (r.dependencies ?? {}) as { allow?: unknown; deny?: unknown }
    const allow = names(deps.allow)
    const deny = names(deps.deny)
    if (allow !== undefined || deny !== undefined)
      rules.push({
        from: sel(tag),
        ...(allow !== undefined ? { allow: allow.map(sel) } : {}),
        ...(deny !== undefined ? { deny: deny.map(sel) } : {}),
      })
    const dependents = (r.dependents ?? {}) as { allow?: unknown; deny?: unknown }
    for (const d of names(dependents.deny) ?? []) rules.push({ from: sel(d), deny: [sel(tag)] })
    const only = names(dependents.allow)
    if (only !== undefined)
      gaps.push(
        `turbo.json boundaries.tags.${tag}.dependents.allow ${JSON.stringify(only)}: vx rules say what a project may depend on, not who may depend on it — add deny: ['tag:${tag}'] to the rule of each other tag`,
      )
  }
  const seen = new Set<string>()
  return {
    rules: rules.filter((r) => {
      const k = JSON.stringify(r)
      return !seen.has(k) && seen.add(k) !== undefined
    }),
    gaps,
  }
}
