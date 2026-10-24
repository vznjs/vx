// Two targets of one project on one output path. vx cleans a task's
// declared outputs before it runs and before a cache-hit restore, so the
// loader refuses two cached tasks whose outputs provably overlap, an edge
// between them or not under core's default `rules.exclusiveOutputs` (X-53).
// A workspace may turn the rule off (item 588's additive shape), but the
// mapping never sees the workspace's rules, so it maps for the default and
// loads under either.
// strapi (2026-09-11) declares `build`, `build:code` and `build:types` all
// on `dist/**`, and twenty's `build:individual` writes into `build`'s
// `dist`; the refusal came at load time, after the migration had reported
// clean. The mapping resolves it: the task with a `^` edge keeps its cache
// (it is the one a dependant waits for), or the first declared when none
// has one; every other task whose outputs overlap a kept task's runs
// uncached, with a todo that names the keeper and the fix (its own output
// path).
//
// The overlap question is core's own `outputsOverlap`, asked through the
// façade. It used to be a COPY of it here, and the copy stopped being the
// same test the moment core's grew: `./dist/**` against `dist/**` (item
// 441) and the literal `dist` against `dist/app.js` (item 442) are
// refused by the loader and were missed here — so the migration reported
// clean on a config core would not load, which is the exact failure this
// file exists to prevent (item 445).

import { isLiteralPattern, outputsOverlap, type GeneratedTask } from '@vzn/vx'
import { withoutTakenBack } from './glob-grammar.js'
import { relPosix } from './paths.js'
import type { TrackedKinds } from './tracked-outputs.js'

// vx cleans outputs before a run and restores them on a hit, so an output
// glob that covers the project's own package.json or vx.config would delete
// it. Core refuses the config file (config-schema's `ownFilesCovered`); the
// manifest it no longer guards (core keys no package file, 2026-10-14), but
// a mapped task still must not delete it. Turbo caches it: trpc's client
// build lists `package.json` (it rewrites `exports`), and the one task made
// core refuse the whole run (2026-09-28). The façade does not export the
// check; tests/own-file-outputs.test.ts holds the config half of this copy
// to the loader in both directions.
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

/**
 * The `!` entries that take the project's own files back from `files`: each
 * own file a positive glob covers and no `!` already takes back. Taken back,
 * it is never cleaned, saved or restored (core's A-44), and core loads it.
 */
export function ownFileTakeBacks(files: readonly string[], config?: string | null): string[] {
  const own =
    config === undefined ? OWN_FILES : config === null ? ['package.json'] : ['package.json', config]
  const glob = (g: string) => new Bun.Glob(g.replace(/^(\.\/)+/, ''))
  const positive = files.filter((g) => !g.startsWith('!')).map(glob)
  const taken = files.filter((g) => g.startsWith('!')).map((g) => glob(g.slice(1)))
  return own
    .filter((f) => positive.some((g) => g.match(f)) && !taken.some((g) => g.match(f)))
    .map((f) => `!${f}`)
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
  /** Let a literal-tail glob through: it reaches only the committed files it names, which core keeps (`literalTailMatches`). */
  literalTail = false,
): string | undefined {
  return files.find(
    (o) =>
      !o.startsWith('!') &&
      !isLiteralPattern(o.split('/')[0] ?? '') &&
      !untrackedKind(o, tracked) &&
      !(literalTail && literalTailMatches(o, tracked) !== null),
  )
}

/**
 * The tracked files a wildcard-first glob with a literal rest can reach
 * (clerk's builds output `*\/package.json`, the subpath stubs it commits):
 * it reaches no other file, and core never cleans a committed one. Null for any other shape, or with `tracked` unknown.
 */
function literalTailMatches(glob: string, tracked?: TrackedKinds): string[] | null {
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

export function wildcardCleanTodo(glob: string): string {
  return (
    `output ${JSON.stringify(glob)}: vx cleans outputs before a run and a restore, so every ` +
    'untracked file this glob reaches is deleted; committed files are kept'
  )
}

const TSBUILDINFO = /(?:^|\/)[^/]*tsbuildinfo[^/]*$/i

interface Cached {
  index: number
  name: string
  files: string[]
  hasUpstreamEdge: boolean
  /** Globs of a sibling's this task's `!` entries take back (`separable`). */
  back: Set<string>
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
  return { index, name: t.name, files: strings, hasUpstreamEdge, back: new Set() }
}

/**
 * Can the keeper's `ga` give `gb`'s tree back? Only when one of the two is
 * a directory at any depth (`**\/dist`, `**\/dist/**`) and the other's
 * literal head names no such directory: they meet only where one tree
 * nests in the other, which neither task writes. solid's build outputs
 * `dist/**` and `**\/dist` beside types' `types/**` and `**\/types`; Turbo
 * caches both, and uncaching types made vx the slower of the two.
 */
const DIR_ANYWHERE = /^\*\*\/([^*?[\]{}()!/\\]+)(?:\/\*\*)?$/

const separable = (ga: string, gb: string): boolean => apart(ga, gb) || apart(gb, ga)

function apart(dir: string, other: string): boolean {
  const name = DIR_ANYWHERE.exec(dir)?.[1]
  if (name === undefined) return false
  const otherName = DIR_ANYWHERE.exec(other)?.[1]
  if (otherName !== undefined) return otherName !== name
  const head: string[] = []
  for (const seg of other.replace(/^(\.\/)+/, '').split('/')) {
    if (!isLiteralPattern(seg) || seg === '') break
    head.push(seg)
  }
  return head.length > 0 && !head.includes(name)
}

/** Does keeper `k`'s `ga` still reach `gb` once its `!` entries are read? */
const hits = (k: Cached, ga: string, gb: string): boolean =>
  !k.back.has(gb) && outputsOverlap(ga, gb)

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
    // `build` is the product Turbo and Nx repos run: typescript-eslint's
    // typecheck (with `^typecheck`) writes declarations into build's dist,
    // and keeping typecheck left every build uncached (Growth parity,
    // 2026-10-14).
    const keeper =
      all.find((c) => c.name === 'build') ?? all.find((c) => c.hasUpstreamEdge) ?? all[0]!
    const kept: Cached[] = [keeper]
    for (const c of all) {
      if (c === keeper) continue
      const clash = kept.find((k) => c.files.some((gb) => k.files.some((ga) => hits(k, ga, gb))))
      if (clash === undefined) {
        kept.push(c)
        continue
      }
      const t = tasks[c.index]!
      const pairs = kept.flatMap((k) =>
        c.files.flatMap((gb) =>
          k.files.filter((ga) => hits(k, ga, gb)).map((ga) => ({ k, ga, gb })),
        ),
      )
      if (pairs.every((p) => separable(p.ga, p.gb))) {
        for (const { k, gb } of pairs) {
          if (k.back.has(gb)) continue
          k.back.add(gb)
          ;(tasks[k.index]!.task!['cache'] as { outputs: { files: string[] } }).outputs.files.push(
            `!${gb}`,
          )
        }
        kept.push(c)
        continue
      }
      // tsc's incremental state is no product: create-t3-turbo's build and
      // typecheck both output `.cache/tsbuildinfo.json`, and typecheck ran
      // uncached on every first run (Growth funnel F8). Left to the keeper,
      // it costs a task that emits nothing else nothing to cache. A task
      // that emits more stays uncached: `tsc --incremental` skips a file
      // the keeper's tsbuildinfo calls built, missing or not, so its save
      // could be a partial dist.
      const sharedFiles = c.files.filter((gb) =>
        kept.some((k) => k.files.some((ga) => hits(k, ga, gb))),
      )
      if (
        sharedFiles.length === c.files.length &&
        sharedFiles.every((g) => isLiteralPattern(g) && TSBUILDINFO.test(g))
      ) {
        c.files = c.files.filter((g) => !sharedFiles.includes(g))
        const outputs = (t.task!['cache'] as { outputs: { files: string[] } }).outputs
        outputs.files = outputs.files.filter((g) => !sharedFiles.includes(g))
        kept.push(c)
        continue
      }
      dropped.add(c.index)
      const shared = c.files.find((gb) => clash.files.some((ga) => hits(clash, ga, gb)))!
      delete t.task!['cache']
      t.todos.push(
        `declares the output ${JSON.stringify(shared)} that ${JSON.stringify(clash.name)} also ` +
          "declares — vx cleans a task's outputs before it runs and before a restore, so two " +
          "cached tasks on one path would delete each other's work; this one runs uncached. " +
          'Give it its own output path to cache it.',
      )
    }
  }
  return tasks
}

/**
 * Two globs can match one path only when one's literal prefix is a
 * directory of the other's (`packages/*\/dist/**` and `packages/a/dist/**`),
 * so an indexed glob is a candidate only along its prefix's chain. Every
 * pair was compared: 1,000 packages' builds and tests took 9 s to map.
 * `candidates` is a superset of the indexed entries a glob can overlap.
 */
function prefixIndex(): {
  index: (i: number, globs: readonly string[]) => void
  candidates: (globs: readonly string[]) => number[]
} {
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
  return {
    index(i, globs) {
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
    },
    candidates(globs) {
      const found = new Set<number>()
      for (const g of globs) {
        const c = chain(g)
        for (const k of ['', ...c]) for (const i of at.get(k) ?? []) found.add(i)
        for (const i of under.get(c.at(-1) ?? '') ?? []) found.add(i)
      }
      return [...found].sort((a, b) => a - b)
    },
  }
}

/**
 * A keyed group (`cache`, no `exec`: the `inputs:<name>` twins, Turbo's
 * transit nodes) runs nothing, so core lets its key read what a task
 * writes (`detectInputOverlaps` exempts it). Uncaching one left `{}`, a
 * task core refuses, and every verb failed.
 */
export const isKeyedGroup = (t: { readonly task: Record<string, unknown> | null }): boolean =>
  t.task !== null && t.task['exec'] === undefined && t.task['inputs'] !== undefined

/**
 * A task whose key cannot be complete: no cache and no key, so it runs
 * every time and every dependant misses (core's keyless task). Uncached
 * alone, its incomplete key still let a dependant hit stale.
 */
export function unkey(task: Record<string, unknown>): void {
  delete task['cache']
  delete task['inputs']
}

/** A task's `inputs` block, when it has one with a `files` list. */
function inputsOf(t: GeneratedTask): { files: string[]; workspaceFiles?: unknown } | undefined {
  const inputs = t.task?.['inputs'] as { files?: unknown } | undefined
  return Array.isArray(inputs?.files)
    ? (inputs as { files: string[]; workspaceFiles?: unknown })
    : undefined
}

/**
 * Core refuses a task whose inputs can match another task's declared
 * outputs (`vx lock`, always, core X-54): such a key
 * reads what a producer writes this run and cannot be known before it ran.
 * Turbo and Nx default a task's inputs to every file of its package
 * (`**\/*`), which matches a sibling build's `dist`. Each overlapping
 * output is taken back with a `!` entry, in place: Turbo and Nx hash the
 * files git tracks, and a build's outputs are not, so the adopted tool
 * never keyed them either. A literal input another task writes cannot be
 * taken back (core refuses a `!` over a literal input), so that task runs
 * uncached with a todo. A reader whose `!` hides a committed file is the
 * tracked pass's (`spareTrackedOutputs`).
 */
export function excludeSiblingOutputs(tasks: GeneratedTask[]): GeneratedTask[] {
  const writers = tasks.flatMap((t, index) => {
    const c = cachedOutputs(t, index)
    return c === null ? [] : [c]
  })
  if (writers.length === 0) return tasks
  tasks.forEach((t, index) => {
    const inputs = inputsOf(t)
    if (inputs === undefined) return
    const positive = inputs.files.filter((g) => typeof g === 'string' && !g.startsWith('!'))
    for (const w of writers) {
      if (w.index === index) continue
      for (const out of w.files) {
        if (inputs.files.includes(`!${out}`)) continue
        const read = positive.filter((g) => outputsOverlap(g, out))
        if (read.length === 0) continue
        const literal = read.find((g) => isLiteralPattern(g))
        if (literal !== undefined && isKeyedGroup(t)) continue
        if (literal !== undefined) {
          unkey(t.task!)
          t.todos.push(
            `reads ${JSON.stringify(literal)}, which ${JSON.stringify(w.name)} writes — vx keys a ` +
              'task only on files no other task writes, so it runs uncached; read the source ' +
              'instead in a vx.config to cache it',
          )
          return
        }
        inputs.files.push(`!${out}`)
      }
    }
  })
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
 * every later task on a kept path runs uncached, with a todo, edge or not,
 * as core refuses the pair either way.
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
  const { index, candidates } = prefixIndex()
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
      // Two own outputs of one project are resolveSharedOutputs'.
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

/**
 * `excludeSiblingOutputs` for root-anchored `inputs.workspaceFiles`:
 * every other task's `outputs.workspaceFiles`, and its `outputs.files` at
 * their workspace path, is taken back from a reader's workspace inputs
 * (Turbo's `globalDependencies` and `$TURBO_ROOT$` entries, Nx's
 * `{workspaceRoot}` filesets). Run after `resolveSharedWorkspaceOutputs`,
 * over what stays cached. A project's own `inputs.files` meets every other
 * task's `outputs.workspaceFiles` the same way, at its workspace path: such
 * an output lands in any project, and core refuses the reader (X-135).
 */
export function excludeWorkspaceOutputs(
  root: string,
  projects: readonly {
    readonly name: string
    readonly dir: string
    readonly tasks: GeneratedTask[]
  }[],
  /** The globs an opaque entry stands for (`vx-migrate`'s `...globalInputs` spread). */
  expand: (entry: unknown) => readonly string[] = () => [],
): void {
  const positive = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((f): f is string => typeof f === 'string' && !f.startsWith('!'))
      : []
  const writers: { task: GeneratedTask; id: string; globs: string[]; ws: string[] }[] = []
  const { index, candidates } = prefixIndex()
  for (const p of projects) {
    const rel = relPosix(root, p.dir)
    for (const t of p.tasks) {
      const outputs = (
        t.task?.['cache'] as { outputs?: { files?: unknown; workspaceFiles?: unknown } } | undefined
      )?.outputs
      const globs = [
        ...positive(outputs?.workspaceFiles),
        ...positive(outputs?.files).map((g) =>
          rel === '' ? g.replace(/^(\.\/)+/, '') : `${rel}/${g.replace(/^(\.\/)+/, '')}`,
        ),
      ]
      if (globs.length === 0) continue
      index(writers.length, globs)
      writers.push({
        task: t,
        id: `${p.name}#${t.name}`,
        globs,
        ws: positive(outputs?.workspaceFiles),
      })
    }
  }
  if (writers.length === 0) return
  for (const p of projects) {
    for (const t of p.tasks) {
      const inputs = t.task?.['inputs'] as { workspaceFiles?: unknown } | undefined
      if (inputs === undefined || !Array.isArray(inputs.workspaceFiles)) continue
      const files = inputs.workspaceFiles as string[]
      const reads = positive(files.flatMap((f) => (typeof f === 'string' ? [f] : expand(f))))
      if (reads.length === 0) continue
      for (const i of candidates(reads)) {
        const w = writers[i]!
        if (w.task === t) continue
        for (const out of w.globs) {
          if (files.includes(`!${out}`)) continue
          const read = reads.filter((g) => outputsOverlap(g, out))
          if (read.length === 0) continue
          const literal = read.find((g) => isLiteralPattern(g))
          if (literal !== undefined && isKeyedGroup(t)) continue
          if (literal !== undefined) {
            unkey(t.task!)
            t.todos.push(
              `reads ${JSON.stringify(literal)}, which ${w.id} writes — vx keys a task only on ` +
                'files no other task writes, so it runs uncached; read the source instead in a ' +
                'vx.config to cache it',
            )
            break
          }
          files.push(`!${out}`)
        }
        if (t.task?.['inputs'] === undefined) break
      }
    }
  }
  for (const p of projects) {
    const rel = relPosix(root, p.dir)
    const at = rel === '' ? '' : `${rel}/`
    for (const t of p.tasks) {
      const files = inputsOf(t)?.files
      if (files === undefined) continue
      const reads = positive(files).map((g) => at + g.replace(/^(\.\/)+/, ''))
      if (reads.length === 0) continue
      for (const i of candidates(reads)) {
        const w = writers[i]!
        if (w.task === t) continue
        for (const out of w.ws) {
          const back = `!${out.slice(at.length)}`
          if (out.startsWith(at) && files.includes(back)) continue
          const read = reads.filter((g) => outputsOverlap(g, out))
          if (read.length === 0) continue
          // An output that reaches in from above (`**/gen/**`) has no
          // project-relative `!` that takes it back.
          const literal = out.startsWith(at) ? read.find((g) => isLiteralPattern(g)) : read[0]
          if (literal !== undefined && isKeyedGroup(t)) continue
          if (literal !== undefined) {
            unkey(t.task!)
            t.todos.push(
              `reads ${JSON.stringify(literal.slice(at.length))}, which ${w.id} writes — vx keys ` +
                'a task only on files no other task writes, so it runs uncached; read the ' +
                'source instead in a vx.config to cache it',
            )
            break
          }
          files.push(back)
        }
        if (t.task?.['inputs'] === undefined) break
      }
    }
  }
}

/**
 * A `!` output with no positive beside it takes back nothing, and core
 * refuses a list of them alone; a literal one takes back was never saved,
 * and core refuses it too (trpc's `package.json`, taken back).
 */
export function takingBack(globs: readonly string[]): string[] {
  const kept = withoutTakenBack(globs)
  return kept.some((g) => !g.startsWith('!')) ? kept : []
}
