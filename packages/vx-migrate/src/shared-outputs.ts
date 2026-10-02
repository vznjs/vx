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

import { isLiteralPattern, outputsOverlap, type GeneratedTask } from '@vzn/vx'
import { relPosix } from './paths.js'
import type { TrackedKinds } from './tracked-outputs.js'

// Core refuses an output glob that covers the project's own package.json
// or vx.config (config-schema's `ownFileCovered`): vx cleans outputs before
// a run and restores them on a hit, so the manifest would go. Turbo caches
// it: trpc's client build lists `package.json` (it rewrites `exports`), and
// the one task made core refuse the whole run (2026-09-28). The façade does
// not export the check; tests/own-file-outputs.test.ts holds this copy to
// the loader in both directions.
const OWN_FILES = ['package.json', 'vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']

/**
 * The first positive output glob that covers a project's own file, and that
 * file. `config` is the config file the mapped task will live beside, as
 * core checks it (null: none); absent, every spelling a user may add later.
 * sanity's builds output `*.js` (top-level shims) beside no vx.config.js.
 */
export function ownFileOutput(
  files: readonly string[],
  config?: string | null,
): { glob: string; file: string } | undefined {
  const own =
    config === undefined ? OWN_FILES : config === null ? ['package.json'] : ['package.json', config]
  for (const glob of files) {
    if (glob.startsWith('!')) continue
    const g = new Bun.Glob(glob.replace(/^(\.\/)+/, ''))
    const file = own.find((f) => g.match(f))
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

// Turbo and Nx never clean an output; vx cleans it before a run and a
// restore, so `**/*.d.ts` deleted a hand-written `src/env.d.ts` and an
// uncommitted edit to it was lost for good (item 1031). A wildcard first
// segment can reach the sources, and a `!` beside it (medusa: `*/**` minus
// `!src/**`) takes back only what it names. typescript-eslint's Nx tests
// output `{projectRoot}/**/*.shot`, 3,656 committed snapshots in one
// package, and nx() lacked the rule (2026-09-29).

/**
 * The first positive output glob whose first segment is a wildcard. Two
 * shapes reach no source when `tracked` is known and says the project has
 * none of their kind, and are let through: one segment ending in a literal
 * extension no tracked file carries (n8n's `*.xml` junit reports, 143 test
 * tasks), and `**` followed by `/<dir>/**` where no tracked file sits
 * under a directory of that name (vercel/ai's builds, `dist` at any depth,
 * 69 of them). A third: a first segment with no `**` that names no tracked
 * top-level entry, and so reaches nothing tracked (tldraw's `dist-*`
 * directories, 35 builds). `*.ts` beside tracked TypeScript, that form over
 * `src`, or a bare `*` directory beside any tracked file is not.
 */
export function wildcardOutput(
  files: readonly string[],
  tracked?: TrackedKinds,
  /** Let a literal-tail glob through once its tracked matches are taken back (`literalTailMatches`). */
  literalTail = false,
): string | undefined {
  return files.find(
    (o) =>
      !o.startsWith('!') &&
      !isLiteralPattern(o.split('/')[0] ?? '') &&
      !untrackedKind(o, tracked) &&
      !(
        literalTail &&
        (literalTailMatches(o, tracked)?.every((m) => files.includes(`!${m}`)) ?? false)
      ),
  )
}

/**
 * The tracked files a wildcard-first glob with a literal rest can reach
 * (clerk's builds output `*\/package.json`, the subpath stubs it commits):
 * it reaches no other file, so with each of these taken back by a `!` it
 * reaches no source. Null for any other shape, or with `tracked` unknown.
 */
export function literalTailMatches(glob: string, tracked?: TrackedKinds): string[] | null {
  if (tracked === undefined || glob.startsWith('!')) return null
  const segs = glob.replace(/^(\.\/)+/, '').split('/')
  const [first, ...rest] = segs
  if (first === undefined || rest.length === 0 || first.includes('**')) return null
  if (/[^A-Za-z0-9*?._@+-]/.test(first) || !rest.every((s) => isLiteralPattern(s) && s !== ''))
    return null
  const tail = `/${rest.join('/')}`
  const head = new Bun.Glob(first)
  return tracked.files.filter(
    (f) => f.endsWith(tail) && f.split('/').length === segs.length && head.match(f.split('/')[0]!),
  )
}

function untrackedKind(glob: string, tracked: TrackedKinds | undefined): boolean {
  if (tracked === undefined) return false
  const g = glob.replace(/^(\.\/)+/, '')
  const ext = /^[^/]*\.([A-Za-z0-9]+)$/.exec(g)?.[1]
  if (ext !== undefined) return !tracked.exts.has(ext.toLowerCase())
  const dir = /^\*\*\/([^*?[\]{}()!/]+)\/\*\*$/.exec(g)?.[1]
  if (dir !== undefined) return !tracked.dirs.has(dir)
  // Brackets, parens and `!` are left out: vx and Bun.Glob read them apart.
  const first = /^([^/[\]()!\\]+)\//.exec(g)?.[1]
  if (first === undefined || first.includes('**')) return false
  const matcher = new Bun.Glob(first)
  return ![...tracked.tops].some((top) => matcher.match(top))
}

export function wildcardTodo(glob: string): string {
  return (
    `output ${JSON.stringify(glob)}: a wildcard first segment reaches the sources, which ` +
    'vx cleans before every run — task runs uncached; declare the exact outputs in a ' +
    'vx.config to cache it'
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
 * no edge between them). A project's own outputs take part at their
 * workspace path: typescript-eslint's root project caches `dist` and every
 * package's typecheck `dist/packages/<name>`, and core refused the run
 * over the nesting. Keepers are the first in project and task order;
 * every later task on a kept path runs uncached, with a todo. Edges are
 * not read: across projects they are the package graph's, which the
 * mapping does not hold, so an ordered pair loses its cache too.
 */
export function resolveSharedWorkspaceOutputs(
  root: string,
  projects: readonly {
    readonly name: string
    readonly dir: string
    readonly tasks: GeneratedTask[]
  }[],
): void {
  const positive = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((f): f is string => typeof f === 'string' && !f.startsWith('!'))
      : []
  const kept: { id: string; project: string; ws: string[]; own: string[] }[] = []
  // Two globs can match one path only when one's literal prefix is a
  // directory of the other's (`packages/*/dist/**` and `packages/a/dist/**`),
  // so a kept glob is a candidate only along its prefix's chain. Every pair
  // was compared: 1,000 packages' builds and tests took 9 s to map.
  const at = new Map<string, number[]>()
  const under = new Map<string, number[]>()
  const chain = (g: string): string[] => {
    const segs: string[] = []
    for (const seg of g.split('/')) {
      if (/[*?{}[\]()!]/.test(seg)) break
      segs.push(seg)
    }
    return segs.map((_, i) => segs.slice(0, i + 1).join('/'))
  }
  const index = (i: number, globs: readonly string[]): void => {
    for (const g of globs) {
      const c = chain(g)
      const push = (m: Map<string, number[]>, k: string) => {
        const list = m.get(k)
        if (list === undefined) m.set(k, [i])
        else if (list.at(-1) !== i) list.push(i)
      }
      push(at, c.at(-1) ?? '')
      for (const k of ['', ...c]) push(under, k)
    }
  }
  const candidates = (globs: readonly string[]): number[] => {
    const found = new Set<number>()
    for (const g of globs) {
      const c = chain(g)
      for (const k of ['', ...c]) for (const i of at.get(k) ?? []) found.add(i)
      for (const i of under.get(c.at(-1) ?? '') ?? []) found.add(i)
    }
    return [...found].sort((a, b) => a - b)
  }
  for (const p of projects) {
    const rel = relPosix(root, p.dir)
    for (const t of p.tasks) {
      const cache = t.task?.['cache'] as
        | { outputs?: { files?: unknown; workspaceFiles?: unknown } }
        | undefined
      const ws = positive(cache?.outputs?.workspaceFiles)
      const own = positive(cache?.outputs?.files).map((g) =>
        rel === '' ? g.replace(/^(\.\/)+/, '') : `${rel}/${g.replace(/^(\.\/)+/, '')}`,
      )
      if (ws.length === 0 && own.length === 0) continue
      // Two own outputs of one project are resolveSharedOutputs', which
      // reads the edges that order them.
      const overlap = (a: string[], b: string[]): string | undefined =>
        a.find((g) => b.some((h) => outputsOverlap(h, g)))
      let clash: (typeof kept)[number] | undefined
      let shared: string | undefined
      for (const i of candidates([...ws, ...own])) {
        const k = kept[i]!
        shared =
          overlap(ws, [...k.ws, ...k.own]) ??
          overlap(own, k.project === p.name ? k.ws : [...k.ws, ...k.own])
        if (shared !== undefined) {
          clash = k
          break
        }
      }
      if (clash === undefined) {
        index(kept.length, [...ws, ...own])
        kept.push({ id: `${p.name}#${t.name}`, project: p.name, ws, own })
        continue
      }
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
