// A file git ignores or does not track (or a committed `.tsbuildinfo`) in
// a task's project that is neither its input nor its output survives the clean before a
// miss and is never restored by a hit.
// An incremental tool keeps its state there (`tsc -b`'s
// `tsconfig.tsbuildinfo`): after vx deleted `dist/`, the state still said
// the outputs were built, so `tsc` emitted only the changed file, exited 0,
// and the partial `dist/` was saved and spread through a shared cache. The
// run cannot see a read, but it can see such a file change while the task
// ran, or outputs come out empty beside one; either result is not saved.
// What is guarded is a partial output, so a task that declares none is
// exempt (`eslint --cache`, `tsc --noEmit --incremental`), and a file any
// task of the project declares as its output is that task's.

import { lstatSync, readFileSync, type Stats } from 'node:fs'
import path from 'node:path'
import type { TaskConfig } from '../config.js'
import { declaresInput, type GitFilesCache } from '../cache/index.js'
import { outputMatcher, printable, relPosix, splitNegations, taskGlobOf } from '../util/index.js'

/**
 * The files a miss stamped before its command, absolute: each one's stamp,
 * and whether git ignores it.
 */
export type StateStamps = ReadonlyMap<string, { at: string | undefined; ignored: boolean }>

function lstatOf(abs: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

const stampFrom = (st: Stats | undefined): string | undefined =>
  st === undefined ? undefined : `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`

const declaresOutputs = (config: TaskConfig): boolean =>
  (config.outputs?.files?.length ?? 0) + (config.outputs?.workspaceFiles?.length ?? 0) > 0

/**
 * The files git ignores or does not track in the task's project (and its
 * committed `.tsbuildinfo` files) that `git status` listed at run start and the task declares neither as an input nor as an output,
 * and no task of its project (`projectTasks`) as an output, stamped. None
 * for a task that declares no outputs. Read from the run's one
 * enumeration: no spawn, a stat each.
 */
export function stampUndeclaredState(args: {
  config: TaskConfig
  projectDir: string
  workspaceRoot: string
  nestedProjectDirs: readonly string[]
  gitFilesCache: GitFilesCache | undefined
  projectTasks: readonly TaskConfig[]
}): StateStamps {
  const { config, projectDir, workspaceRoot } = args
  if (!declaresOutputs(config)) return new Map()
  // Untracked too: a `.gitignore` that names `dist` and not
  // `*.tsbuildinfo` left the state untracked, and the partial `dist/` saved.
  const ignored = args.gitFilesCache?.ignoredFilesIn(projectDir) ?? []
  const untracked = args.gitFilesCache?.untrackedFilesIn(projectDir) ?? []
  // A committed `.tsbuildinfo` (`git add -A` before `.gitignore` named it)
  // is state all the same; no other tracked file is stamped.
  const loose = new Set(untracked)
  for (const rel of args.gitFilesCache?.get(projectDir) ?? []) {
    if (!rel.endsWith('.tsbuildinfo')) continue
    const abs = path.join(projectDir, rel)
    if (!loose.has(abs)) untracked.push(abs)
  }
  if (ignored.length + untracked.length === 0) return new Map()
  // Each task's own matcher: one's negation does not take back another's glob.
  // A file an output's `!` entry takes back is declared all the same: kept
  // across builds on purpose (`'.next/**', '!.next/cache/**'`, where Next's
  // type check keeps its `.tsbuildinfo`), it withheld every save but the first.
  const outs = [...new Set([config, ...args.projectTasks])].filter(declaresOutputs).map((c) => ({
    own: outputMatcher(splitNegations(c.outputs?.files ?? []).positive),
    ws: outputMatcher(splitNegations(c.outputs?.workspaceFiles ?? []).positive),
  }))
  const dir = relPosix(workspaceRoot, projectDir)
  const nested = new Set(args.nestedProjectDirs)
  const inNested = (abs: string): boolean => {
    for (let d = path.dirname(abs); d.length > projectDir.length; d = path.dirname(d))
      if (nested.has(d)) return true
    return false
  }
  // vx writes its cache directory (SQLite's WAL) while the task runs.
  const vxDirs = args.gitFilesCache?.vxDirs ?? []
  const out = new Map<string, { at: string | undefined; ignored: boolean }>()
  for (const [i, abs] of [...ignored, ...untracked].entries()) {
    if (nested.size > 0 && inNested(abs)) continue
    if (vxDirs.some((d) => abs.startsWith(d + path.sep))) continue
    const rel = relPosix(projectDir, abs)
    // vx's own files at the workspace root.
    if (rel.startsWith('.vx/') || rel.startsWith('.git/')) continue
    const wsRel = relPosix(workspaceRoot, abs)
    if (outs.some((o) => o.own(rel) || o.ws(wsRel))) continue
    if (declaresInput(config, rel, wsRel, false, true, dir)) continue
    const isIgnored = i < ignored.length
    const st = lstatOf(abs)
    // A tool's state is a file: an untracked link is the task's own way to
    // its outputs (`ln -sfn real-out dist` under `dist/**`), rewritten each run.
    if (!isIgnored && st?.isFile() !== true) continue
    out.set(abs, { at: stampFrom(st), ignored: isIgnored })
  }
  return out
}

/** A `.tsbuildinfo` larger than this is taken as per-file state unread. */
const BUILD_INFO_READ_MAX = 4 << 20

/**
 * Whether `abs` may hold per-file build state. A `.tsbuildinfo` a
 * non-incremental `tsc -b` writes lists only its roots and version
 * (`{"root":[…],"version":…}`): such a build emits its whole project, and
 * rebuilds outputs gone missing, so nothing it reads back cuts them short.
 * Vite's template (`tsc -b` with `noEmit`, its state in
 * `node_modules/.tmp`) rewrites one on every edit, and every save after the
 * first was withheld. Nor does an incremental one that emits nothing
 * (`emitsNothing`).
 */
function holdsState(abs: string, size: number | undefined): boolean {
  if (!abs.endsWith('.tsbuildinfo') || size === undefined || size > BUILD_INFO_READ_MAX) return true
  try {
    const info: unknown = JSON.parse(readFileSync(abs, 'utf8'))
    if (typeof info !== 'object' || info === null || 'program' in info) return true
    if (!('fileNames' in info)) return false
    return !emitsNothing(info)
  } catch {
    return true
  }
}

/**
 * Whether an incremental buildinfo records every root file as still to
 * emit: a `noEmit` build (create-vue's `vue-tsc --build`, `tsc -b` with
 * `composite` and `noEmit`) never emits, so it claims no output as built.
 * `root` holds file ids and `[first, last]` ranges, and
 * `affectedFilesPendingEmit` ids or `[id, kind]` pairs.
 */
function emitsNothing(info: object): boolean {
  const root = 'root' in info ? info.root : undefined
  const pending = 'affectedFilesPendingEmit' in info ? info.affectedFilesPendingEmit : undefined
  if (!Array.isArray(root) || !Array.isArray(pending) || root.length === 0) return false
  const ids = new Set<unknown>(pending.map((p: unknown) => (Array.isArray(p) ? p[0] : p)))
  for (const r of root as unknown[]) {
    if (typeof r === 'number') {
      if (!ids.has(r)) return false
    } else if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number') {
      for (let id = r[0]; id <= r[1]; id++) if (!ids.has(id)) return false
    } else return false
  }
  return true
}

/** The stamped files the command changed and left in place, holding state, project-relative. */
export function stateChanged(stamps: StateStamps, projectDir: string): string[] {
  const changed: string[] = []
  for (const [abs, before] of stamps) {
    const st = lstatOf(abs)
    const after = stampFrom(st)
    // One the task removed cannot be read back.
    if (after === undefined || after === before.at || !holdsState(abs, st?.size)) continue
    changed.push(relPosix(projectDir, abs))
  }
  return changed
}

/**
 * The stamped files still there, project-relative. Of those git does not
 * ignore, only `.tsbuildinfo` files: before a first commit every source is
 * untracked, and a task whose outputs came out empty beside its own
 * `package.json` was refused its save.
 */
export function stateLeft(stamps: StateStamps, projectDir: string): string[] {
  const left: string[] = []
  for (const [abs, s] of stamps) {
    if (!s.ignored && !abs.endsWith('.tsbuildinfo')) continue
    const st = lstatOf(abs)
    if (st !== undefined && holdsState(abs, st.size)) left.push(relPosix(projectDir, abs))
  }
  return left
}

/**
 * The way out both warnings give: the files as `outputs.files` entries, of
 * the task that writes them when another task of the project (`alongside`)
 * ran with it and may have.
 */
export function declareStateHint(rels: readonly string[], alongside?: string): string {
  const globs = rels
    .map((r) => `'${printable(taskGlobOf(r)).replace(/[\\']/g, '\\$&')}'`)
    .join(', ')
  const it = rels.length === 1 ? 'it' : 'them'
  return (
    (alongside === undefined ? '' : `; ${alongside} ran alongside and may have written ${it}`) +
    `; declare ${it} in outputs.files (${globs})` +
    (alongside === undefined ? '' : ' of the task that writes ' + it) +
    `, so a miss starts without ${it} and a hit restores ${it}`
  )
}
