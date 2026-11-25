// Did every task under a saving miss keep the inputs its key folded? A key
// folds each dependency's input key, never its bytes: a dependency's source
// edited while its dependant ran (an editor, a sibling task writing there)
// let the dependant build from bytes no key names, and the save filed them
// under the dependency's old key. Undo the edit and every later hit replayed
// the edited build under a green run.
//
// Two checks, so a run pays for each file about once, not once per dependant
// (a closure re-stat'd by every save took a 9,603-task cold run from 120 s to
// 288 s). A save re-stats a task under it only when a command, restore or
// fetch that may write its project ran since its inputs were last found
// unmoved: every write in contract. A write out of contract (a task writing
// another project, an editor) needs no window, so once the graph is done
// one sweep stats every input under a save again and drops each entry built
// over one that moved.

import { lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { foldedDeps, type TaskNode } from '../graph/index.js'
import { ABSENT_INPUT } from '../cache/index.js'
import { FILE_HASH_RACY_MS, fsClockNow, racyWindowMs, stampGrainMs } from '../memo/index.js'
import { outputMatcher, printable, relPosix, span } from '../util/index.js'
import { type Logger, warnOf } from '../report/index.js'
import { hashArgsOf } from './execute-args.js'
import type { ExecuteArgs, RunContext } from './execute-task.js'
import type { CommandWindows } from './command-windows.js'
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
}

/** `lstatSync(file).ctimeMs`, or undefined when there is no file. */
type CtimeOf = (file: string) => number | undefined

const ctimeNow: CtimeOf = (file) => {
  try {
    return lstatSync(file).ctimeMs
  } catch {
    return undefined
  }
}

/** One run's tasks as each settled its key, by id. */
export class KeyedTasks {
  private readonly keyed = new Map<string, Keyed>()
  private readonly foldedIds = new Map<string, readonly string[]>()
  /**
   * The tasks a write in contract may have reached since their inputs were
   * last found unmoved: keyed since, or a command, restore or fetch that may
   * write their project opened since. A save stats only these of its closure.
   */
  private readonly dirty = new Set<string>()
  private projectDirs: string[] | undefined
  /** `projectsAt`, by directory. */
  private readonly under = new Map<string, readonly string[]>()
  /** The tasks some key folds: only these are ever asked (`dirty`). */
  private foldedAny: Set<string> | undefined
  /** Keyed tasks by project directory, for a window that opens there. */
  private readonly byProject = new Map<string, Set<string>>()
  /** Each node's index into `closureBits`. */
  private readonly index = new Map<string, number>()
  /** Every task a node's key folds, transitively, as bits over `index`. */
  private readonly closureBits = new Map<string, Uint32Array>()
  /** The entries this run saved here, for the end sweep (`sweep`). */
  private readonly savedHere: { args: ExecuteArgs; hash: string }[] = []
  /** Windows opened so far: a `reachedSince` answer stands until another opens. */
  private opens = 0

  constructor(
    private readonly nodes: ReadonlyMap<string, TaskNode>,
    /** When the up-front keys were taken: every key dispatch does not take again. */
    readonly keysFrom: number,
    private readonly keysFromMs: number,
    private readonly windows?: CommandWindows,
  ) {
    let i = 0
    for (const id of nodes.keys()) this.index.set(id, i++)
    windows?.onOpen((dir, reach) => {
      this.opens++
      if (reach === 'workspace') {
        for (const id of this.keyed.keys()) this.dirty.add(id)
        return
      }
      for (const projectDir of this.projectsAt(dir))
        for (const id of this.byProject.get(projectDir) ?? []) this.dirty.add(id)
    })
  }

  /** The project directories at or under `dir`: a window there may write in each. */
  private projectsAt(dir: string): readonly string[] {
    let dirs = this.under.get(dir)
    if (dirs === undefined) {
      this.projectDirs ??= [...new Set([...this.nodes.values()].map((n) => n.projectDir))].sort()
      const all = this.projectDirs
      const inside = dir + path.sep
      const found: string[] = all.includes(dir) ? [dir] : []
      // Sorted: everything under `dir` is one run of entries from `inside` on.
      let lo = 0
      let hi = all.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (all[mid]! < inside) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < all.length && all[i]!.startsWith(inside); i++) found.push(all[i]!)
      dirs = found
      this.under.set(dir, dirs)
    }
    return dirs
  }

  /** A task dispatched: its key is the up-front one until `keyedNow` says otherwise. */
  dispatched(args: ExecuteArgs): void {
    const { id, projectDir } = args.node
    this.keyed.set(id, { args, at: this.keysFrom, atMs: this.keysFromMs })
    this.dirty.add(id)
    const ids = this.byProject.get(projectDir)
    if (ids === undefined) this.byProject.set(projectDir, new Set([id]))
    else ids.add(id)
  }

  /** The task takes its key now. */
  keyedNow(args: ExecuteArgs): void {
    const k = this.keyed.get(args.node.id)
    if (k === undefined) return
    k.at = clockOf(args.run)
    k.atMs = Date.now()
    this.dirty.add(args.node.id)
  }

  /** The task took its key at `at` (the file system's clock), `atMs` (ms epoch), before its dispatch (`prepareKey`). */
  keyedAt(args: ExecuteArgs, at: number, atMs: number): void {
    const k = this.keyed.get(args.node.id)
    if (k === undefined) return
    k.at = at
    k.atMs = atMs
    this.dirty.add(args.node.id)
  }

  /** A miss's command ended: its facts answer for its inputs from here. */
  ran(args: ExecuteArgs, facts: readonly InputFact[] | undefined, at: number): void {
    const k = this.keyed.get(args.node.id)
    if (k === undefined) return
    k.at = at
    k.atMs = Date.now()
    if (facts !== undefined) k.facts = facts
    this.dirty.add(args.node.id)
  }

  /** An entry saved here under `hash`: the end sweep may take it back. */
  saved(args: ExecuteArgs, hash: string): void {
    if (args.executor.capabilities?.remote !== true) this.savedHere.push({ args, hash })
  }

  /**
   * The first task under `args` (dependencies of dependencies too, through
   * groups) with an input written in contract since its key was settled, or
   * undefined. Each is stat'd only while a write may have reached it since
   * it was last found unmoved (`dirty`); the end sweep answers for writes out
   * of contract.
   */
  async moved(
    args: ExecuteArgs,
  ): Promise<{ task: string; file: string; sinceMs: number } | undefined> {
    const bits = this.bitsOf(args.node)
    const folded = (this.foldedAny ??= this.foldedByAny())
    // Each file stat'd once per save, not once per task reading it: on a
    // one-project chain every task is dirty again after each command, and
    // their shared inputs were lstat'd N times a save, N² a run. A ctime
    // read now stands for the whole sweep, so a task is dropped only when
    // nothing that may write its project opened since the sweep began.
    const from = Date.now()
    const ctimes = new Map<string, number | undefined>()
    const ctimeOf: CtimeOf = (file) => {
      if (ctimes.has(file)) return ctimes.get(file)
      const c = ctimeNow(file)
      ctimes.set(file, c)
      return c
    }
    // Per project for the sweep: from a fixed `from`, a window only ever
    // adds to the answer, and only by opening, which `opens` counts.
    const answers = new Map<string, boolean>()
    let answersAt = this.opens
    const reached = (windows: CommandWindows, dir: string): boolean => {
      if (answersAt !== this.opens) {
        answers.clear()
        answersAt = this.opens
      }
      let r = answers.get(dir)
      if (r === undefined) answers.set(dir, (r = windows.reachedSince(dir, from, Date.now())))
      return r
    }
    for (const id of this.dirty) {
      // No key folds it: no save ever asks.
      if (!folded.has(id)) {
        this.dirty.delete(id)
        continue
      }
      const i = this.index.get(id)
      if (i === undefined || (bits[i >>> 5]! & (1 << (i & 31))) === 0) continue
      const k = this.keyed.get(id)!
      const node = k.args.node
      // A server's inputs are its live state, and a task with no inputs keys none.
      if (node.config.inputs === undefined || node.config.exec?.persistent !== undefined) {
        this.dirty.delete(id)
        continue
      }
      const sweep = movedSince(k, args, ctimeOf)
      const file = typeof sweep === 'object' ? await sweep : sweep
      if (file !== undefined) return { task: id, file, sinceMs: k.atMs }
      // Unmoved as of `from`, and nothing that may write there opened since,
      // the awaits included (a window opening then marked it before this
      // drop): the next write in contract opens a window, which marks it again.
      if (this.windows !== undefined && !reached(this.windows, node.projectDir))
        this.dirty.delete(id)
    }
    return undefined
  }

  /**
   * Once the graph is done: every input under an entry this run saved, each
   * file stat'd once, and each entry over one written after its task's key
   * was taken removed again. Writes in contract were judged at each save;
   * this catches the rest (a task writing into another project, an editor).
   */
  async sweep(run: RunContext, log: Logger): Promise<void> {
    if (this.savedHere.length === 0) return
    const discard = run.cache.discard
    if (discard === undefined) return
    const end = span('upstream inputs sweep')
    const under = new Set<string>()
    const stack: string[] = []
    for (const { args } of this.savedHere) stack.push(...this.folded(args.node))
    while (stack.length > 0) {
      const id = stack.pop()!
      if (under.has(id)) continue
      under.add(id)
      const node = this.nodes.get(id)
      if (node !== undefined) stack.push(...this.folded(node))
    }
    const swept: Keyed[] = []
    for (const id of under) {
      const k = this.keyed.get(id)
      const node = this.nodes.get(id)
      if (k === undefined || node === undefined) continue
      if (node.config.inputs === undefined || node.config.exec?.persistent !== undefined) continue
      swept.push(k)
    }
    const ctimes = await ctimesOf(swept)
    const ctimeOf: CtimeOf = (file) => {
      if (ctimes.has(file)) return ctimes.get(file)
      const c = ctimeNow(file)
      ctimes.set(file, c)
      return c
    }
    const moved = new Map<string, { file: string; sinceMs: number }>()
    for (const k of swept) {
      const id = k.args.node.id
      const sweep = movedSince(k, k.args, ctimeOf)
      const file = typeof sweep === 'object' ? await sweep : sweep
      if (file !== undefined) moved.set(id, { file, sinceMs: k.atMs })
    }
    end()
    if (moved.size === 0) return
    const dropped = new Map<string, string[]>()
    for (const { args, hash } of this.savedHere) {
      const seen = new Set<string>()
      const todo = [...this.folded(args.node)]
      let hit: string | undefined
      while (todo.length > 0 && hit === undefined) {
        const id = todo.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        if (moved.has(id)) hit = id
        else {
          const node = this.nodes.get(id)
          if (node !== undefined) todo.push(...this.folded(node))
        }
      }
      if (hit === undefined) continue
      await discard.call(run.cache, hash).catch(() => {})
      const list = dropped.get(hit)
      if (list === undefined) dropped.set(hit, [args.node.id])
      else list.push(args.node.id)
    }
    for (const [task, ids] of dropped) {
      const { file, sinceMs } = moved.get(task)!
      const rel = printable(relPosix(run.workspaceRoot, file))
      const by = run.commandWindows?.writerDuring(task, file, sinceMs, Date.now())
      const named =
        ids.slice(0, 3).join(', ') + (ids.length > 3 ? ` and ${ids.length - 3} more` : '')
      warnOf(log)(
        `[vx] \`${rel}\`, an input of ${task}, changed after that task's key was taken` +
          (by === undefined ? '' : ` while ${by} ran`) +
          ` — the results stand, but the entries of ${named} are dropped: their keys do not name the bytes they were built from`,
      )
    }
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

  private foldedByAny(): Set<string> {
    const ids = new Set<string>()
    for (const node of this.nodes.values()) for (const id of this.folded(node)) ids.add(id)
    return ids
  }

  /** Every task `node`'s key folds, transitively, as bits over `index`. */
  private bitsOf(node: TaskNode): Uint32Array {
    const known = this.closureBits.get(node.id)
    if (known !== undefined) return known
    const bits = new Uint32Array((this.index.size + 31) >>> 5)
    for (const id of this.folded(node)) {
      const i = this.index.get(id)
      const dep = this.nodes.get(id)
      if (i === undefined || dep === undefined) continue
      bits[i >>> 5]! |= 1 << (i & 31)
      const b = this.bitsOf(dep)
      for (let w = 0; w < bits.length; w++) bits[w]! |= b[w]!
    }
    this.closureBits.set(node.id, bits)
    return bits
  }
}

/**
 * Every file the sweep reads, each lstat'd once, on the thread pool: one
 * at a time on the main thread, the site's 32,000 inputs held a cold run's
 * end ~70 ms. A file found absent maps to undefined, as `ctimeNow` says.
 */
async function ctimesOf(swept: readonly Keyed[]): Promise<Map<string, number | undefined>> {
  const files = new Set<string>()
  for (const k of swept) {
    if (k.facts !== undefined) for (const f of k.facts) files.add(f.path)
    else for (const f of await (k.files ??= ownInputs(k.args))) files.add(f)
  }
  const list = [...files]
  const found = await Promise.all(
    list.map((f) =>
      lstat(f).then(
        (st) => st.ctimeMs,
        () => undefined,
      ),
    ),
  )
  const ctimes = new Map<string, number | undefined>()
  for (let i = 0; i < list.length; i++) ctimes.set(list[i]!, found[i])
  return ctimes
}

function clockOf(run: RunContext): number {
  return fsClockNow(run.cacheDir ?? path.join(run.workspaceRoot, '.vx'))
}

/** Undefined, or a promise of it, when nothing moved: most sweeps settle with no await. */
function movedSince(
  k: Keyed,
  dependant: ExecuteArgs,
  ctimeOf: CtimeOf,
): string | undefined | Promise<string | undefined> {
  const at = k.at
  // A write stamped in the tick `at` was read in may be the task's own last
  // one (tsdown's package.json): judged by its bytes. Any later one moved
  // the file whatever it holds.
  if (k.facts !== undefined)
    return unwritten(k.facts, at, ctimeOf)
      ? undefined
      : movedInput(k.facts, dependant.run.cache, at, (_, ctimeMs) => ctimeMs <= at)
  return movedFile(k, dependant, ctimeOf)
}

/**
 * Every fact's file written before both its digest was learned and `at`,
 * by its ctime alone: `movedInput` would hash none of them. One lstat each.
 */
function unwritten(facts: readonly InputFact[], at: number, ctimeOf: CtimeOf): boolean {
  for (const f of facts) {
    if (f.behind !== undefined) return false
    const ctimeMs = ctimeOf(f.path)
    if (ctimeMs === undefined) {
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

async function movedFile(
  k: Keyed,
  dependant: ExecuteArgs,
  ctimeOf: CtimeOf,
): Promise<string | undefined> {
  const { cache, gitFilesCache } = dependant.run
  const at = k.at
  k.files ??= ownInputs(k.args)
  const { projectDir } = k.args.node
  for (const f of await k.files) {
    const ctimeMs = ctimeOf(f)
    if (ctimeMs === undefined) {
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
  const files = await inputFilesOf(hashArgsOf(args))
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
