// An edge to a task that mapped to nothing (a lage target with no script, a
// wireit script with neither command nor dependencies) is refused by core:
// no project declares the name, and the refusal failed the whole run. The
// mappers drop such edges with a todo, to a fixed point, since a group
// task left with no edge maps to nothing in turn.

interface Mapped {
  readonly name: string
  readonly tasks: { readonly name: string; todos: string[]; task: Record<string, unknown> | null }[]
}

export function pruneDanglingEdges(projects: readonly Mapped[]): void {
  for (;;) {
    const live = new Map<string, Set<string>>()
    const anywhere = new Set<string>()
    for (const p of projects) {
      const names = new Set(p.tasks.filter((t) => t.task !== null).map((t) => t.name))
      live.set(p.name, names)
      for (const n of names) anywhere.add(n)
    }
    let changed = false
    for (const p of projects) {
      for (const t of p.tasks) {
        const deps = t.task?.['dependsOn']
        if (!Array.isArray(deps)) continue
        const kept = deps.filter((d: string) => {
          if (d.startsWith('^')) return anywhere.has(d.slice(1))
          const hash = d.indexOf('#')
          const ok =
            hash === -1
              ? live.get(p.name)?.has(d)
              : live.get(d.slice(0, hash))?.has(d.slice(hash + 1))
          if (ok !== true)
            t.todos.push(`edge ${JSON.stringify(d)}: that task has no vx form — edge dropped`)
          return ok === true
        })
        if (kept.length === deps.length) continue
        changed = true
        if (kept.length > 0) t.task!['dependsOn'] = kept
        else {
          delete t.task!['dependsOn']
          if (t.task!['exec'] === undefined) {
            t.todos.push('a group task with no edge left — nothing to run')
            t.task = null
          }
        }
      }
    }
    if (!changed) return
  }
}
