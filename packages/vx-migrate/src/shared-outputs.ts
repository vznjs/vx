// Two targets of one project on one output path. vx cleans a task's
// declared outputs before it runs and before a cache-hit restore, so the
// loader refuses two cached tasks whose outputs provably overlap (core's
// task-graph.ts, the same conservative test: equal literals, a literal a
// glob matches, identical globs). strapi (2026-09-11) declares `build`,
// `build:code` and `build:types` all on `dist/**`, and the refusal came
// at load time, after the migration had reported clean. The mapping
// resolves it: the task with a `^` edge keeps its cache (it is the one a
// dependant waits for), or the first declared when none has one; every
// other task on that path runs uncached, with a todo that names the
// keeper and the fix (its own output path).

import type { GeneratedTask } from '@vzn/vx'

function isLiteralGlob(g: string): boolean {
  return g.search(/[*?[\]]/) === -1
}

function outputsOverlap(a: string, b: string): boolean {
  if (isLiteralGlob(a) && isLiteralGlob(b)) return a === b
  if (isLiteralGlob(a)) return new Bun.Glob(b).match(a)
  if (isLiteralGlob(b)) return new Bun.Glob(a).match(b)
  return a === b
}

interface Cached {
  index: number
  name: string
  files: string[]
  hasUpstreamEdge: boolean
}

function cachedOutputs(t: GeneratedTask, index: number): Cached | null {
  const task = t.task
  if (task === null) return null
  const cache = task['cache'] as { outputs?: { files?: unknown } } | undefined
  const files = cache?.outputs?.files
  if (!Array.isArray(files)) return null
  const strings = files.filter((f): f is string => typeof f === 'string')
  if (strings.length === 0) return null
  const deps = task['dependsOn']
  const hasUpstreamEdge =
    Array.isArray(deps) && deps.some((d) => typeof d === 'string' && d.startsWith('^'))
  return { index, name: t.name, files: strings, hasUpstreamEdge }
}

/**
 * Uncache every task whose declared outputs overlap a keeper's, in place,
 * and return the tasks. Deterministic: keepers are chosen in declaration
 * order, so the same graph maps the same way every run.
 */
export function resolveSharedOutputs(tasks: GeneratedTask[]): GeneratedTask[] {
  const cached: Cached[] = []
  tasks.forEach((t, i) => {
    const c = cachedOutputs(t, i)
    if (c !== null) cached.push(c)
  })
  const dropped = new Set<number>()
  for (const a of cached) {
    if (dropped.has(a.index)) continue
    const group = cached.filter(
      (b) =>
        b !== a &&
        !dropped.has(b.index) &&
        a.files.some((ga) => b.files.some((gb) => outputsOverlap(ga, gb))),
    )
    if (group.length === 0) continue
    const all = [a, ...group]
    const keeper = all.find((c) => c.hasUpstreamEdge) ?? all[0]!
    for (const c of all) {
      if (c === keeper) continue
      dropped.add(c.index)
      const t = tasks[c.index]!
      const shared = c.files.find((gb) => keeper.files.some((ga) => outputsOverlap(ga, gb)))!
      delete t.task!['cache']
      t.todos.push(
        `declares the output ${JSON.stringify(shared)} that ${JSON.stringify(keeper.name)} also ` +
          "declares — vx cleans a task's outputs before it runs and before a restore, so two " +
          "cached tasks on one path would delete each other's work; this one runs uncached. " +
          'Give it its own output path to cache it.',
      )
    }
  }
  return tasks
}
