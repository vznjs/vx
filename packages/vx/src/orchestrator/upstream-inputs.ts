// Did every task under a saving miss keep the inputs its key folded? A key
// folds each dependency's input key, never its bytes: a dependency's source
// edited while its dependant ran (an editor, a sibling task writing there)
// let the dependant build from bytes no key names, and the save filed them
// under the dependency's old key. Undo the edit and every later hit replayed
// the edited build under a green run.

import { lstatSync } from 'node:fs'
import path from 'node:path'
import { foldedDeps, type TaskNode } from '../graph/index.js'
import { ABSENT_INPUT } from '../cache/index.js'
import { FILE_HASH_RACY_MS, fsClockNow, racyWindowMs, stampGrainMs } from '../memo/index.js'
import { outputMatcher, relPosix, span } from '../util/index.js'
import type { ExecuteArgs, RunContext } from './execute-task.js'
import { type InputFact, inputFilesOf, movedInput } from './task-hash.js'

/** What a dependant's save asks of one task under it. */
interface Keyed {
  args: ExecuteArgs
  /**
   * On the file system's clock, when its key stopped answering for a write
   * to its inputs: a hit's key taken, a miss's command ended (its own
   * re-check covers its command). A write at or after it is one no key folded.
   */
  at: number
  /** `at` on `Date.now()`'s clock, for the commands that ran since (command-windows.ts). */
  atMs: number
  /** A miss's keyed facts, judged as its own re-check judges them. */
  facts?: readonly InputFact[]
  /** A hit's input files, listed again on the first dependant's save. */
  files?: Promise<readonly string[]>
  /**
   * When a sweep found its inputs and its whole closure's unmoved: a
   * dependant whose command ended before it needs none of it walked again.
   */
  closureCleanAt?: number
}

/** One run's tasks as each settled its key, by id. */
export class KeyedTasks {
  private readonly keyed = new Map<string, Keyed>()
  private readonly foldedIds = new Map<string, readonly string[]>()

  constructor(
    private readonly nodes: ReadonlyMap<string, TaskNode>,
    /** When the up-front keys were taken: every key dispatch does not take again. */
    readonly keysFrom: number,
    private readonly keysFromMs: number,
  ) {}

  /** A task dispatched: its key is the up-front one until `keyedNow` says otherwise. */
  dispatched(args: ExecuteArgs): void {
    this.keyed.set(args.node.id, { args, at: this.keysFrom, atMs: this.keysFromMs })
  }

  /** The task takes its key now. */
  keyedNow(args: ExecuteArgs): void {
    const k = this.keyed.get(args.node.id)
    if (k === undefined) return
    k.at = clockOf(args.run)
    k.atMs = Date.now()
  }

  /** A miss's command ended: its facts answer for its inputs from here. */
  ran(args: ExecuteArgs, facts: readonly InputFact[] | undefined, at: number): void {
    const k = this.keyed.get(args.node.id)
    if (k === undefined) return
    k.at = at
    k.atMs = Date.now()
    if (facts !== undefined) k.facts = facts
  }

  /**
   * The first task under `args` (dependencies of dependencies too, through
   * groups) with an input written since its key was settled, or undefined.
   * `until` is when the dependant's command ended, on the same clock.
   */
  async moved(
    args: ExecuteArgs,
    until: number,
  ): Promise<{ task: string; file: string; sinceMs: number } | undefined> {
    const from = clockOf(args.run)
    // Every task visited had its inputs, and its own closure's, unmoved as of
    // `clean`: a later dependant whose command ended before it walks none of it.
    let clean = from
    const seen = new Set<string>()
    const visited: Keyed[] = []
    const stack = [...this.folded(args.node)]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const node = this.nodes.get(id)
      if (node === undefined) continue
      const k = this.keyed.get(id)
      if (k?.closureCleanAt !== undefined && k.closureCleanAt >= until) {
        clean = Math.min(clean, k.closureCleanAt)
        continue
      }
      stack.push(...this.folded(node))
      if (k === undefined) continue
      visited.push(k)
      // A server's inputs are its live state, and a task with no inputs keys none.
      if (node.config.inputs === undefined || node.config.exec?.persistent !== undefined) continue
      const sweep = movedSince(k, args)
      const file = typeof sweep === 'object' ? await sweep : sweep
      if (file !== undefined) return { task: id, file, sinceMs: k.atMs }
    }
    for (const k of visited) k.closureCleanAt = Math.max(k.closureCleanAt ?? clean, clean)
    return undefined
  }

  /** The tasks `node`'s key folds (`inputs.tasks`): one it does not fold answers for nothing in it. */
  private folded(node: TaskNode): readonly string[] {
    let ids = this.foldedIds.get(node.id)
    if (ids === undefined) {
      ids = foldedDeps(node, (id) => this.nodes.get(id)!).map((c) => c.node.id)
      this.foldedIds.set(node.id, ids)
    }
    return ids
  }
}

function clockOf(run: RunContext): number {
  return fsClockNow(run.cacheDir ?? path.join(run.workspaceRoot, '.vx'))
}

/** Undefined, or a promise of it, when nothing moved: most sweeps settle with no await. */
function movedSince(
  k: Keyed,
  dependant: ExecuteArgs,
): string | undefined | Promise<string | undefined> {
  const at = k.at
  // A write stamped in the tick `at` was read in may be the task's own last
  // one (tsdown's package.json): judged by its bytes. Any later one moved
  // the file whatever it holds.
  if (k.facts !== undefined)
    return unwritten(k.facts, at)
      ? undefined
      : movedInput(k.facts, dependant.run.cache, at, (_, ctimeMs) => ctimeMs <= at)
  return movedFile(k, dependant)
}

/**
 * Every fact's file written before both its digest was learned and `at`,
 * by its ctime alone: `movedInput` would hash none of them. One lstat each.
 */
function unwritten(facts: readonly InputFact[], at: number): boolean {
  for (const f of facts) {
    if (f.behind !== undefined) return false
    let ctimeMs: number
    try {
      ctimeMs = lstatSync(f.path).ctimeMs
    } catch {
      if (f.digest === ABSENT_INPUT) continue
      return false
    }
    if (f.digest === ABSENT_INPUT) return false
    const grainMs = stampGrainMs(ctimeMs)
    if (ctimeMs >= at - grainMs || ctimeMs >= f.since - racyWindowMs(ctimeMs, FILE_HASH_RACY_MS))
      return false
  }
  return true
}

async function movedFile(k: Keyed, dependant: ExecuteArgs): Promise<string | undefined> {
  const { cache, gitFilesCache } = dependant.run
  const at = k.at
  k.files ??= ownInputs(k.args)
  const { projectDir } = k.args.node
  for (const f of await k.files) {
    let ctimeMs: number
    try {
      ctimeMs = lstatSync(f).ctimeMs
    } catch {
      // Gone: since `at` only if its directory changed since.
      if (changedAfter(path.dirname(f), at)) return f
      continue
    }
    if (ctimeMs > at) return f
    if (ctimeMs < at - stampGrainMs(ctimeMs)) continue
    // Its tick: the identity the run learned for it, if it learned one.
    const known =
      gitFilesCache?.oidsFor(projectDir)?.get(f) ??
      gitFilesCache?.oidsFor(dependant.run.workspaceRoot)?.get(f) ??
      gitFilesCache?.identityOf(f)
    if (known === undefined) continue
    if ((await cache.memo.hashFile(f).catch(() => undefined)) !== known) return f
  }
  return undefined
}

function changedAfter(dir: string, at: number): boolean {
  try {
    return lstatSync(dir).ctimeMs > at
  } catch {
    return true
  }
}

/** A hit's input files less its own outputs, which its restore writes. */
async function ownInputs(args: ExecuteArgs): Promise<readonly string[]> {
  const end = span('miss: list upstream inputs')
  const { node, run } = args
  const files = await inputFilesOf({
    node,
    upstream: args.upstream,
    workspaceRoot: run.workspaceRoot,
    cache: run.cache,
    forwardArgs: run.forwardArgs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(run.gitFilesCache !== undefined ? { gitFilesCache: run.gitFilesCache } : {}),
    ...(run.hashCache !== undefined ? { hashCache: run.hashCache } : {}),
  })
  end()
  const own = node.config.outputs?.files ?? []
  const ws = node.config.outputs?.workspaceFiles ?? []
  if (own.length === 0 && ws.length === 0) return files
  const ownOut = outputMatcher(own)
  const wsOut = outputMatcher(ws)
  return files.filter(
    (f) => !ownOut(relPosix(node.projectDir, f)) && !wsOut(relPosix(run.workspaceRoot, f)),
  )
}
