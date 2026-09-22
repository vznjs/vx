// The readiness note a persistent task carries ("add `readyWhen` to gate
// dependents") is moot for a task nothing depends on: no one waits for it,
// so there is nothing to gate. refine printed it for 375 `dev` and `start`
// tasks on every run, none of them anyone's dependency (item 602). Both
// mappers run this last, over the whole mapping, since a dependent may sit
// in another package.

export interface NotedTask {
  readonly name: string
  readonly todos: string[]
  readonly task: Record<string, unknown> | null
}

/** Strips the note from every persistent task no `dependsOn` in the mapping names. */
export function pruneOrphanPersistentNotes(
  projects: readonly { readonly tasks: readonly NotedTask[] }[],
  note: string,
): void {
  const referenced = new Set<string>()
  for (const project of projects) {
    for (const t of project.tasks) {
      const deps = t.task?.['dependsOn']
      if (!Array.isArray(deps)) continue
      for (const d of deps) {
        if (typeof d !== 'string') continue
        // `^name`, `pkg#name` and `name` all name the same task.
        const hash = d.indexOf('#')
        referenced.add(hash === -1 ? d.replace(/^\^/, '') : d.slice(hash + 1))
      }
    }
  }
  for (const project of projects) {
    for (const t of project.tasks) {
      if (referenced.has(t.name)) continue
      const at = t.todos.indexOf(note)
      if (at !== -1) t.todos.splice(at, 1)
    }
  }
}
