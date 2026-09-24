// The toy monorepo the Learn widgets draw. The static render (the no-JS
// fallback) and the element that enhances it both read this one model, so
// the diagram, the table and the highlighted set cannot disagree about what
// depends on what.

export interface ToyPackage {
  id: string
  /** The workspace packages its package.json depends on. */
  dependsOn: string[]
}

export const TOY_PACKAGES: ToyPackage[] = [
  { id: 'utils', dependsOn: [] },
  { id: 'ui', dependsOn: ['utils'] },
  { id: 'api', dependsOn: ['utils'] },
  { id: 'app', dependsOn: ['ui', 'api'] },
]

export interface ToyTask {
  /** `pkg#name`, the way Turborepo and vx spell a task. */
  id: string
  pkg: string
  name: 'build' | 'test'
  /** Task ids that must finish before this one starts. */
  dependsOn: string[]
}

/** Each package has the same two tasks, wired by the two rules most
 *  monorepos write: `build` depends on `^build` (the build of every package
 *  it depends on), and `test` depends on `build` (its own package's). */
export const TOY_TASKS: ToyTask[] = TOY_PACKAGES.flatMap((p): ToyTask[] => [
  { id: `${p.id}#build`, pkg: p.id, name: 'build', dependsOn: p.dependsOn.map((d) => `${d}#build`) },
  { id: `${p.id}#test`, pkg: p.id, name: 'test', dependsOn: [`${p.id}#build`] },
])

const byId = new Map(TOY_TASKS.map((t) => [t.id, t]))

/** The package and everything that depends on it, directly or through
 *  another package: the set a change to it affects. In model order. */
export function affectedBy(pkg: string): string[] {
  const affected = new Set([pkg])
  // A Set visits what is added during iteration, so this walks the closure.
  for (const current of affected) {
    for (const p of TOY_PACKAGES) if (p.dependsOn.includes(current)) affected.add(p.id)
  }
  return TOY_PACKAGES.map((p) => p.id).filter((p) => affected.has(p))
}

/** The tasks `--affected` selects when `pkg` changes: every task of every
 *  affected package. In model order. */
export function rerunBy(pkg: string): string[] {
  const affected = affectedBy(pkg)
  return TOY_TASKS.filter((t) => affected.includes(t.pkg)).map((t) => t.id)
}

/** The tasks the selected ones depend on that are not selected themselves.
 *  The run needs them first; nothing they read changed, so a cache that
 *  holds them restores them instead of running them. In model order. */
export function neededBy(pkg: string): string[] {
  const rerun = new Set(rerunBy(pkg))
  const needed = new Set<string>()
  const visit = (id: string): void => {
    for (const dep of byId.get(id)!.dependsOn) {
      if (rerun.has(dep) || needed.has(dep)) continue
      needed.add(dep)
      visit(dep)
    }
  }
  for (const id of rerun) visit(id)
  return TOY_TASKS.map((t) => t.id).filter((id) => needed.has(id))
}

/** The wave a task can start in: 1 for a task with no dependencies,
 *  otherwise one after the latest of its dependencies. Every task in a wave
 *  can run at the same time. */
export function waveOf(id: string): number {
  const deps = byId.get(id)!.dependsOn
  return deps.length === 0 ? 1 : 1 + Math.max(...deps.map(waveOf))
}

/** The given tasks grouped by wave, earliest first, each wave in model order. */
export function waves(ids: string[] = TOY_TASKS.map((t) => t.id)): string[][] {
  const byWave = new Map<number, string[]>()
  for (const t of TOY_TASKS) {
    if (!ids.includes(t.id)) continue
    const w = waveOf(t.id)
    byWave.set(w, [...(byWave.get(w) ?? []), t.id])
  }
  return [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!)
}

/** `a, then b and c together, then d`: one valid order for the given tasks. */
export function orderSentence(ids: string[]): string {
  return waves(ids)
    .map((w) => (w.length === 1 ? w[0]! : `${joinNames(w)} together`))
    .join(', then ')
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
