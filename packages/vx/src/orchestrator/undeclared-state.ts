// A git-ignored file in a task's project that is neither its input nor its
// output survives the clean before a miss and is never restored by a hit.
// An incremental tool keeps its state there (`tsc -b`'s
// `tsconfig.tsbuildinfo`): after vx deleted `dist/`, the state still said
// the outputs were built, so `tsc` emitted only the changed file, exited 0,
// and the partial `dist/` was saved and spread through a shared cache. The
// run cannot see a read, but it can see such a file change while the task
// ran, or outputs come out empty beside one; either result is not saved.
// What is guarded is a partial output, so a task that declares none is
// exempt (`eslint --cache`, `tsc --noEmit --incremental`), and a file any
// task of the project declares as its output is that task's.

import { lstatSync } from 'node:fs'
import path from 'node:path'
import type { TaskConfig } from '../config.js'
import { declaresInput, type GitFilesCache } from '../cache/index.js'
import { outputMatcher, printable, relPosix, taskGlobOf } from '../util/index.js'

/** The files a miss stamped before its command, absolute, with their stamps. */
export type StateStamps = ReadonlyMap<string, string | undefined>

function stampOf(abs: string): string | undefined {
  try {
    const st = lstatSync(abs, { throwIfNoEntry: false })
    return st === undefined ? undefined : `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`
  } catch {
    return undefined
  }
}

const declaresOutputs = (config: TaskConfig): boolean =>
  (config.outputs?.files?.length ?? 0) + (config.outputs?.workspaceFiles?.length ?? 0) > 0

/**
 * The git-ignored files in the task's project that `git status` listed at
 * run start and the task declares neither as an input nor as an output,
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
  const found = args.gitFilesCache?.ignoredFilesIn(projectDir) ?? []
  if (found.length === 0) return new Map()
  // Each task's own matcher: one's negation does not take back another's glob.
  const outs = [...new Set([config, ...args.projectTasks])].filter(declaresOutputs).map((c) => ({
    own: outputMatcher(c.outputs?.files ?? []),
    ws: outputMatcher(c.outputs?.workspaceFiles ?? []),
  }))
  const dir = relPosix(workspaceRoot, projectDir)
  const nested = new Set(args.nestedProjectDirs)
  const inNested = (abs: string): boolean => {
    for (let d = path.dirname(abs); d.length > projectDir.length; d = path.dirname(d))
      if (nested.has(d)) return true
    return false
  }
  const out = new Map<string, string | undefined>()
  for (const abs of found) {
    if (nested.size > 0 && inNested(abs)) continue
    const rel = relPosix(projectDir, abs)
    // vx's own files at the workspace root.
    if (rel.startsWith('.vx/') || rel.startsWith('.git/')) continue
    const wsRel = relPosix(workspaceRoot, abs)
    if (outs.some((o) => o.own(rel) || o.ws(wsRel))) continue
    if (declaresInput(config, rel, wsRel, false, true, dir)) continue
    out.set(abs, stampOf(abs))
  }
  return out
}

/** The stamped files the command changed and left in place, project-relative. */
export function stateChanged(stamps: StateStamps, projectDir: string): string[] {
  const changed: string[] = []
  for (const [abs, before] of stamps) {
    const after = stampOf(abs)
    // One the task removed cannot be read back.
    if (after !== undefined && after !== before) changed.push(relPosix(projectDir, abs))
  }
  return changed
}

/** The stamped files still there, project-relative. */
export function stateLeft(stamps: StateStamps, projectDir: string): string[] {
  const left: string[] = []
  for (const abs of stamps.keys())
    if (stampOf(abs) !== undefined) left.push(relPosix(projectDir, abs))
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
