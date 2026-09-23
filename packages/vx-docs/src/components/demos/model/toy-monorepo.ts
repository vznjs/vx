// The toy monorepo the Learn widgets draw. The static render (the no-JS
// fallback) and the element that enhances it both read this one model, so
// the caption and the highlighted set cannot disagree about what depends on
// what.

export interface ToyPackage {
  id: string
  dependsOn: string[]
}

export const TOY_PACKAGES: ToyPackage[] = [
  { id: 'ui', dependsOn: [] },
  { id: 'api', dependsOn: [] },
  { id: 'app', dependsOn: ['ui', 'api'] },
]

/** The package and everything that depends on it, directly or through
 *  another package: the set a change to it affects. In model order. */
export function affectedBy(id: string): string[] {
  const affected = new Set([id])
  // A Set visits what is added during iteration, so this walks the closure.
  for (const current of affected) {
    for (const p of TOY_PACKAGES) if (p.dependsOn.includes(current)) affected.add(p.id)
  }
  return TOY_PACKAGES.map((p) => p.id).filter((p) => affected.has(p))
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
