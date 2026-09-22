// Two targets of one project on one output path. vx cleans a task's
// declared outputs before it runs and before a cache-hit restore, so the
// loader refuses two cached tasks whose outputs provably overlap — UNLESS
// a same-project edge orders them (core item 588): then the dependant is
// ADDITIVE, keeps its cache, and owns only what its run added. strapi
// (2026-09-11) declares `build`, `build:code` and `build:types` all on
// `dist/**`, and the refusal came at load time, after the migration had
// reported clean. The mapping resolves it: the task with a `^` edge keeps
// its cache (it is the one a dependant waits for), or the first declared
// when none has one; every other task on that path stays cached when an
// edge orders it against every kept task it overlaps, and otherwise runs
// uncached, with a todo that names the keeper and the fix (its own output
// path, or the edge).
//
// The overlap question is core's own `outputsOverlap`, asked through the
// façade. It used to be a COPY of it here, and the copy stopped being the
// same test the moment core's grew: `./dist/**` against `dist/**` (item
// 441) and the literal `dist` against `dist/app.js` (item 442) are
// refused by the loader and were missed here — so the migration reported
// clean on a config core would not load, which is the exact failure this
// file exists to prevent (item 445).

import { outputsOverlap, type GeneratedTask } from '@vzn/vx'

interface Cached {
  index: number
  name: string
  files: string[]
  hasUpstreamEdge: boolean
  /** Same-project `dependsOn` names (no `^`), for the ordering test. */
  localDeps: string[]
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
  const localDeps = Array.isArray(deps)
    ? deps.filter((d): d is string => typeof d === 'string' && !d.startsWith('^'))
    : []
  return { index, name: t.name, files: strings, hasUpstreamEdge, localDeps }
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
  // Does `from` reach `to` through same-project edges? The generated
  // tasks of one project are the whole graph here.
  // Every task, cached or not: a hop through an uncached group task is an
  // edge too.
  const depsByName = new Map<string, string[]>()
  for (const t of tasks) {
    const deps = t.task?.['dependsOn']
    depsByName.set(
      t.name,
      Array.isArray(deps)
        ? deps.filter((d): d is string => typeof d === 'string' && !d.startsWith('^'))
        : [],
    )
  }
  const reaches = (from: Cached, to: Cached): boolean => {
    const seen = new Set<string>()
    const stack = [...from.localDeps]
    while (stack.length > 0) {
      const n = stack.pop()!
      if (n === to.name) return true
      if (seen.has(n)) continue
      seen.add(n)
      for (const d of depsByName.get(n) ?? []) stack.push(d)
    }
    return false
  }
  const ordered = (x: Cached, y: Cached): boolean => reaches(x, y) || reaches(y, x)
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
    const kept: Cached[] = [keeper]
    for (const c of all) {
      if (c === keeper) continue
      // Additive under core's rule when an edge orders it against every
      // kept task whose outputs it overlaps: it stays cached, no todo.
      const unordered = kept.find(
        (k) => c.files.some((gb) => k.files.some((ga) => outputsOverlap(ga, gb))) && !ordered(c, k),
      )
      if (unordered === undefined) {
        kept.push(c)
        continue
      }
      dropped.add(c.index)
      const t = tasks[c.index]!
      const shared = c.files.find((gb) => unordered.files.some((ga) => outputsOverlap(ga, gb)))!
      delete t.task!['cache']
      t.todos.push(
        `declares the output ${JSON.stringify(shared)} that ${JSON.stringify(unordered.name)} also ` +
          "declares — vx cleans a task's outputs before it runs and before a restore, so two " +
          "cached tasks on one path would delete each other's work; this one runs uncached. " +
          `Give it its own output path to cache it, or a dependsOn edge on ${JSON.stringify(unordered.name)} ` +
          'so vx orders them and caches what this one adds.',
      )
    }
  }
  return tasks
}
