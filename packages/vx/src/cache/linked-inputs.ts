// A symlinked input keys the content behind it, as Nx reads a linked file where
// it points. Its own fold stays the blob of its target STRING (file-hashes.ts),
// so a retarget to equal bytes moves the key; this is what follows it. The
// target string alone let an edit behind the link replay the old output
// wherever the target lies: in the project, elsewhere in the
// workspace, outside it. A directory link keys every file beneath it, tracked
// or not, where Nx does not enter one: an edit there is an edit to what the
// task reads. `--affected` (workspace/affected.ts) and `vx watch`
// (cli/watch.ts) read the same targets.
//
// Never into another project (principle 6), from a link in the task's own
// project. Followed, `b/src/a -> ../../a` keyed a's gitignored dist, so a's
// restore between b's up-front key and its run re-keyed b, which was never
// saved. With a `dependsOn` path to that project the link keys its target
// string alone, and what b reads there reaches its key as that project's
// input keys; with none it is refused (`VX_E_NESTED_INPUT`), as a glob into
// another project is. A link among `inputs.workspaceFiles` has no boundary.

import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { relPosix, UserError, xxh3hex } from '../util/index.js'
import { absentOr } from './key-fold.js'

/** What a dangling link, or a loop of links, holds behind it: nothing to read. */
const NOTHING_BEHIND = ''

/**
 * Directories a linked directory's walk never enters, as Nx's walker never
 * does (its HARDCODED_IGNORE_PATTERNS): a link to a workspace would
 * otherwise key the cache each run writes.
 */
const SKIPPED = ['.git', 'node_modules', '.vx/cache', '.yarn/cache']
const skipped = (rel: string): boolean => SKIPPED.some((s) => rel === s || rel.endsWith(`/${s}`))

/** A project as a link's boundary names it. */
interface ProjectAt {
  readonly name: string
  readonly dir: string
}

/** What a run tells the boundary: its projects, and its tasks by id. */
interface RunBounds {
  readonly projects: readonly ProjectAt[]
  readonly task: (id: string) =>
    | {
        readonly projectDir: string
        readonly deps: readonly string[]
        readonly config: {
          readonly inputs?: { readonly files: readonly string[] }
          readonly outputs?: { readonly files: readonly string[] }
        }
      }
    | undefined
  /** Made real, deepest first, at the first link: links are rare. */
  real?: ProjectAt[]
  readonly reach: Map<string, ReadonlyMap<string, readonly Declared[]>>
}

/** One reached task's declared files, relative to its project. */
interface Declared {
  readonly files: readonly string[]
}

const boundsByRoot = new Map<string, RunBounds>()

/**
 * Set as a run builds its graph: each project, and each task's `projectDir`
 * and `deps`, so a link input knows its task's project and the projects its
 * `dependsOn` reaches. Nothing is resolved until a link input asks.
 */
export function setLinkBounds(
  workspaceRoot: string,
  projects: readonly ProjectAt[],
  task: RunBounds['task'],
): void {
  boundsByRoot.set(workspaceRoot, { projects, task, reach: new Map() })
}

function realOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const within = (dir: string, p: string, sep: string = path.sep): boolean =>
  p === dir || p.startsWith(dir + sep)

/** The task a link input belongs to, when the link lies in the task's own project. */
interface LinkBounds {
  readonly root: string
  readonly link: string
  readonly taskId: string
  readonly own: string
  readonly run: RunBounds
  readonly projects: readonly ProjectAt[]
}

function boundsOf(link: string, taskId: string | undefined): LinkBounds | undefined {
  if (taskId === undefined || boundsByRoot.size === 0) return undefined
  const at = realOr(path.dirname(link))
  for (const [root, run] of boundsByRoot) {
    if (!within(realOr(root), at)) continue
    const node = run.task(taskId)
    if (node === undefined) return undefined
    const own = realOr(node.projectDir)
    // Outside its project: an `inputs.workspaceFiles` link, which has no boundary.
    if (!within(own, at)) return undefined
    const projects = (run.real ??= run.projects
      .map((p) => ({ name: p.name, dir: realOr(p.dir) }))
      .sort((a, b) => b.dir.length - a.dir.length))
    return { root, link, taskId, own, run, projects }
  }
  return undefined
}

/**
 * The projects `id`'s `dependsOn` reaches, at any depth, its own aside:
 * each with the files its reached tasks declare (`inputs.files` and
 * `outputs.files`, one list a task).
 */
function reachOf(run: RunBounds, id: string): ReadonlyMap<string, readonly Declared[]> {
  const known = run.reach.get(id)
  if (known !== undefined) return known
  const out = new Map<string, Declared[]>()
  const seen = new Set<string>([id])
  const stack = [...(run.task(id)?.deps ?? [])]
  while (stack.length > 0) {
    const d = stack.pop()!
    if (seen.has(d)) continue
    seen.add(d)
    const node = run.task(d)
    if (node === undefined) continue
    const dir = realOr(node.projectDir)
    let list = out.get(dir)
    if (list === undefined) out.set(dir, (list = []))
    list.push(
      { files: node.config.inputs?.files ?? [] },
      { files: node.config.outputs?.files ?? [] },
    )
    stack.push(...node.deps)
  }
  run.reach.set(id, out)
  return out
}

/**
 * Whether `rel` (project-relative, `/`-separated) lies under `declared`: a
 * file one of its globs matches, or a directory a `dir/**` (or `**`) glob
 * holds whole; either with no negation reaching into it.
 */
function covers(declared: Declared, rel: string, isDir: boolean): boolean {
  const neg = declared.files.filter((f) => f.startsWith('!')).map((f) => f.slice(1))
  const pos = declared.files.filter((f) => !f.startsWith('!'))
  if (isDir) {
    const holds = pos.some(
      (f) => f === '**' || (f.endsWith('/**') && within(f.slice(0, -3), rel, '/')),
    )
    return holds && !neg.some((n) => within(rel, n, '/') || new Bun.Glob(n).match(rel))
  }
  return pos.some((f) => new Bun.Glob(f).match(rel)) && !neg.some((n) => new Bun.Glob(n).match(rel))
}

/**
 * Whether `real` lies in a project other than the task's own: `false` when
 * not, `true` when a task its `dependsOn` reaches there declares it among
 * its inputs or outputs (keyed through that task), and a refusal otherwise:
 * keyed by its target string alone, an edit to an undeclared file behind it
 * replayed the old output.
 */
function otherProject(bounds: LinkBounds | undefined, real: string): boolean {
  if (bounds === undefined) return false
  const owner = bounds.projects.find((p) => within(p.dir, real))
  if (owner === undefined || owner.dir === bounds.own) return false
  const declared = reachOf(bounds.run, bounds.taskId).get(owner.dir)
  const rel = relPosix(owner.dir, real)
  let isDir = false
  try {
    isDir = statSync(real).isDirectory()
  } catch {
    isDir = false
  }
  if (declared?.some((d) => covers(d, rel, isDir)) === true) return true
  const link = relPosix(bounds.root, bounds.link)
  const own = relPosix(
    bounds.own,
    path.join(realOr(path.dirname(bounds.link)), path.basename(bounds.link)),
  )
  const target = relPosix(realOr(bounds.root), real)
  throw new UserError(
    `${bounds.taskId} reads ${link} in inputs.files, a link into the project ${owner.name} ` +
      `(${target}): a project's inputs never reach another project's files, so an edit there ` +
      `would replay a stale hit. ` +
      (declared === undefined
        ? `Depend on a task of ${owner.name}`
        : `Depend on a task of ${owner.name} that declares ${rel} in its inputs.files or outputs`) +
      `, or take the link back ` +
      `with "!${own}" and name the files in inputs.workspaceFiles (${JSON.stringify(target)}).`,
    'VX_E_NESTED_INPUT',
  )
}

/**
 * The files under `dir` a linked directory keys, relative and `/`-separated,
 * sorted: every regular file and link at any depth. A link is listed, never
 * entered (`behindLink` follows it), so a loop of directories ends. Under
 * a link's bounds a directory of another project is not entered.
 */
export function filesBehind(dir: string): string[] {
  return walkBehind(dir, undefined)
}

function walkBehind(dir: string, bounds: LinkBounds | undefined): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        const child = path.join(abs, e.name)
        if (!skipped(childRel) && !otherProject(bounds, child)) walk(child, childRel)
      } else if (e.isFile() || e.isSymbolicLink()) out.push(childRel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * The content behind the symlink at `link`, as one string: a file's identity
 * (`hashFile` of its real path), a directory's files and theirs, or
 * `NOTHING_BEHIND` for a dangling link, a loop or a target in a project
 * `taskId`'s `dependsOn` reaches (`otherProject`). A special file (a FIFO, a
 * device) is named, never read: a read can block. Never memoized: an upstream
 * task may write behind the link between two keys.
 */
export function behindLink(
  link: string,
  hashFile: (file: string) => Promise<string>,
  taskId?: string,
): Promise<string> {
  return follow(link, hashFile, new Set(), boundsOf(link, taskId))
}

async function follow(
  link: string,
  hashFile: (file: string) => Promise<string>,
  seen: ReadonlySet<string>,
  bounds: LinkBounds | undefined,
): Promise<string> {
  let real: string
  let st
  try {
    real = realpathSync(link)
    st = statSync(real)
  } catch {
    return NOTHING_BEHIND
  }
  if (seen.has(real) || otherProject(bounds, real)) return NOTHING_BEHIND
  // A repository's own store, as a `.git/**` input names nothing: walked,
  // every commit and index write re-keyed the task. Its target string keys.
  if (real.split(path.sep).includes('.git')) return NOTHING_BEHIND
  if (st.isFile()) return `file\0${await hashFile(real).catch(absentOr)}`
  if (!st.isDirectory()) return 'special'
  const inner = new Set(seen).add(real)
  const parts = await Promise.all(
    walkBehind(real, bounds).map(async (rel) => {
      const abs = path.join(real, rel)
      const id = await hashFile(abs).catch(absentOr)
      return id.startsWith('120000:')
        ? `${rel}\0${id}\0${await follow(abs, hashFile, inner, bounds)}`
        : `${rel}\0${id}`
    }),
  )
  return `dir\0${xxh3hex(parts.join('\n'))}`
}
