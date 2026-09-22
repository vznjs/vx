// What a mapping could not say, reported once per run by the plugin that
// runs it live. One line per DISTINCT gap, not one per task: n8n has a
// `dev` and a `watch` in most of its 84 packages, and astro's `build`
// carries the same `!vendor/**` output in every package — the per-task
// form was a hundred identical lines before the first frame (2026-09-11).
// Shared by `turbo()` and `nx()` since the second one existed.

/** What both mappers' projects have in common: a name and tasks with todos. */
interface MappedProject {
  readonly name: string
  readonly tasks: readonly { readonly name: string; readonly todos: readonly string[] }[]
}

export interface Gaps {
  readonly notes: readonly string[]
  /** Every task-level gap, keyed on its text, to the `pkg#task` ids that carry it. */
  readonly todos: ReadonlyMap<string, readonly string[]>
}

/** The gaps of a mapping, indexed for the one-line-per-gap report. */
export function collectGaps(projects: readonly MappedProject[], notes: readonly string[]): Gaps {
  const todos = new Map<string, string[]>()
  for (const project of projects) {
    for (const t of project.tasks) {
      for (const todo of t.todos) {
        let ids = todos.get(todo)
        if (ids === undefined) todos.set(todo, (ids = []))
        ids.push(`${project.name}#${t.name}`)
      }
    }
  }
  return { notes, todos }
}

export function warnGaps(warn: (line: string) => void, pluginName: string, gaps: Gaps): void {
  for (const note of gaps.notes) warn(`[${pluginName}] ${note}`)
  for (const [todo, ids] of gaps.todos) {
    if (ids.length === 1) {
      warn(`[${pluginName}] ${ids[0]}: ${todo}`)
      continue
    }
    const names = [...new Set(ids.map((id) => id.slice(id.indexOf('#') + 1)))]
    const packages = new Set(ids.map((id) => id.slice(0, id.indexOf('#'))))
    warn(
      `[${pluginName}] ${ids.length} task(s) (${names.join(', ')} across ${packages.size} package(s)): ${todo}`,
    )
  }
}
