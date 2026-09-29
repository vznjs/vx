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

// Core refuses an output glob that covers the project's own package.json
// or vx.config (config-schema's `ownFileCovered`): vx cleans outputs before
// a run and restores them on a hit, so the manifest would go. Turbo caches
// it: trpc's client build lists `package.json` (it rewrites `exports`), and
// the one task made core refuse the whole run (2026-09-28). The façade does
// not export the check; tests/own-file-outputs.test.ts holds this copy to
// the loader in both directions.
const OWN_FILES = ['package.json', 'vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']

/** The first positive output glob that covers a project's own file, and that file. */
export function ownFileOutput(
  files: readonly string[],
): { glob: string; file: string } | undefined {
  for (const glob of files) {
    if (glob.startsWith('!')) continue
    const g = new Bun.Glob(glob.replace(/^(\.\/)+/, ''))
    const file = OWN_FILES.find((f) => g.match(f))
    if (file !== undefined) return { glob, file }
  }
  return undefined
}

export function ownFileTodo(own: { glob: string; file: string }): string {
  return (
    `output ${JSON.stringify(own.glob)} covers the project's own ${own.file}, which vx cleans ` +
    'before every run — task runs uncached; declare the outputs without it in a vx.config to cache it'
  )
}

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
  // Where a task's outputs might land is its positive globs, as core reads
  // them: a `!` compiled as a glob is true of every other path.
  const strings = files.filter((f): f is string => typeof f === 'string' && !f.startsWith('!'))
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

/**
 * The same across projects, for workspace outputs: cal.com's shared
 * `post-install` writes `../../node_modules/@prisma/client/**` from every
 * package that has the script, one workspace path, and core refused the
 * whole run over the first pair (two projects' outputs on one path with
 * no edge between them). Keepers are the first in project and task order;
 * every later task on a kept path runs uncached, with a todo. Edges are
 * not read: across projects they are the package graph's, which the
 * mapping does not hold, so an ordered pair loses its cache too.
 */
export function resolveSharedWorkspaceOutputs(
  projects: readonly { readonly name: string; readonly tasks: GeneratedTask[] }[],
): void {
  const kept: { id: string; files: string[] }[] = []
  for (const p of projects) {
    for (const t of p.tasks) {
      const cache = t.task?.['cache'] as { outputs?: { workspaceFiles?: unknown } } | undefined
      const ws = cache?.outputs?.workspaceFiles
      if (!Array.isArray(ws)) continue
      const files = ws.filter((f): f is string => typeof f === 'string' && !f.startsWith('!'))
      if (files.length === 0) continue
      const clash = kept.find((k) =>
        k.files.some((ga) => files.some((gb) => outputsOverlap(ga, gb))),
      )
      if (clash === undefined) {
        kept.push({ id: `${p.name}#${t.name}`, files })
        continue
      }
      const shared = files.find((gb) => clash.files.some((ga) => outputsOverlap(ga, gb)))!
      delete t.task!['cache']
      t.todos.push(
        `declares the workspace output ${JSON.stringify(shared)} that ${clash.id} also declares — ` +
          "vx cleans a task's outputs before it runs and before a restore, so two cached tasks " +
          "on one path would delete each other's work; this one runs uncached. Give it its own " +
          'output path to cache it.',
      )
    }
  }
}

/** A `!` output with no positive beside it takes back nothing, and core refuses a list of them alone. */
export function takingBack(globs: readonly string[]): string[] {
  return globs.some((g) => !g.startsWith('!')) ? [...globs] : []
}
