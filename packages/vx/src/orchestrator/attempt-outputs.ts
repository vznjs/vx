// vx's own work on a miss's declared outputs around each attempt: the clean
// before it (or, for an additive task, the stamp), and after a pass, which
// files are the task's own to save. What it finds that no entry could
// replay (a removed committed file, a found file a failed attempt touched)
// makes `own()` answer undefined: the task saves nothing. A declared output
// the pass never wrote fails it (`missingOutputs`).

import { lstatSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  cleanOutputPaths,
  cleanOutputs,
  cleanWorkspaceOutputs,
  committedFiles,
  committedMoved,
  type OutputStamp,
  ownOutputsSince,
  ownWorkspaceOutputsSince,
  resolveOutputs,
  resolveWorkspaceOutputs,
  stampCommitted,
  stampOutputs,
  stampWorkspaceOutputs,
  taskEntryHashes,
  writeIndexBlobs,
} from '../cache/index.js'
import { type OutputFileRow, WORKSPACE_OUTPUT_PREFIX } from '../memo/index.js'
import { OutputsFailed, type TaskOutcome } from '../graph/index.js'
import { warnOf } from '../report/index.js'
import {
  anyTaskGlob,
  asTrees,
  isLiteralPattern,
  relPosix,
  span,
  splitNegations,
  taskGlob,
} from '../util/index.js'
import type { ExecuteArgs } from './execute-task.js'
import type { TaskPolicy } from './task-policy.js'

/** The files a save stores as the task's own; absent fields mean all it declares. */
export interface OwnOutputs {
  ownOutputFiles?: string[]
  ownWsOutputFiles?: string[]
}

/** vx's own work on the outputs, around a command that exited `exitCode`. */
export async function outputsStep<T>(
  step: 'clean' | 'save',
  exitCode: number,
  spentMs: number,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw new OutputsFailed(err, step, exitCode, spentMs)
  }
}

export class OutputGuard {
  readonly cleanArgs
  readonly wsCleanArgs
  // An ADDITIVE task (its outputs overlap an upstream's, with the edge that
  // orders them) does not clean by glob: the glob selects the upstream's
  // files it adds beside. Its outputs are stamped once before the first
  // attempt, and after a 0 exit its own set is what the run added or
  // changed against that stamp, or found as a save or restore of its own
  // left it (`leftByOwnEntries`); a retry first removes what the failed
  // attempt added (`dropFailedAdditions`). Stale files of its own from an
  // earlier run are its command's to clean, as they are under Turbo.
  private stampedBefore: ReadonlyMap<string, OutputStamp> | undefined
  private wsStampedBefore: ReadonlyMap<string, OutputStamp> | undefined
  // A failed attempt changed or removed a file the stamp found, or a
  // committed file under the outputs (no clean deletes one): no retry can
  // put it back, so no entry holds only the passing attempt's work.
  private failedTouchedFound = false
  // The committed files under the outputs as the first attempt found them,
  // stamped only when a retry can follow.
  private committedBefore: ReadonlyMap<string, OutputStamp> | undefined
  private wsCommittedBefore: ReadonlyMap<string, OutputStamp> | undefined
  // The committed files the last attempt's clean found and left (absolute).
  // One its run removed cannot be replayed by a hit, whose restore leaves
  // it too: that run saves nothing.
  private committedKept: string[] = []

  constructor(
    private readonly args: ExecuteArgs,
    private readonly policy: TaskPolicy,
  ) {
    const { node } = args
    const ownInputs = {
      projectDir: node.projectDir,
      workspaceRoot: args.run.workspaceRoot,
      declared: node.config.inputs,
    }
    this.cleanArgs = {
      projectDir: node.projectDir,
      outputs: policy.outputs,
      nestedProjectDirs: args.outputNestedDirs ?? args.nestedProjectDirs,
      inputs: ownInputs,
      committed: committedFiles(args.run.gitFilesCache, node.projectDir),
    }
    this.wsCleanArgs = {
      workspaceRoot: args.run.workspaceRoot,
      outputs: policy.wsOutputs,
      inputs: ownInputs,
      committed: committedFiles(args.run.gitFilesCache, args.run.workspaceRoot),
    }
  }

  /**
   * Before attempt `attempt`: clean the declared outputs (before EVERY
   * attempt, so a stale prior-build artifact can't survive into a fresh
   * run, and a failed attempt's partial outputs can't leak into the next;
   * gated on WRITES so a `--no-cache` run leaves the user's tree alone).
   */
  async prepare(attempt: number, held?: ReadonlyMap<string, string>): Promise<void> {
    const { args, policy, cleanArgs, wsCleanArgs } = this
    const { node } = args
    const { outputs, wsOutputs, additive, write, deferred, keepOutputs, retryCanFollow } = policy
    // A deferred task's outputs are deliberately NOT coming, so wiping the
    // tree would replace a stale build with nothing at all. The eligibility
    // gate guarantees no key in this run can see what stays behind, and the
    // summary names every deferred task so `dist/` is not silently stale.
    // The first attempt under `clean: false` finds its last outputs (tsc's
    // `.tsbuildinfo`).
    const clean = write && !deferred && !(keepOutputs && attempt === 1)
    this.committedKept = []
    if (clean && held !== undefined) {
      // The key folded what git holds for these, not the bytes an earlier
      // build left: the command starts from it, as on a clean checkout, so
      // one that reads or appends to them saves what that checkout builds.
      writeIndexBlobs(held)
      args.run.gitFilesCache?.markOutputsChanged(
        node.projectDir,
        [...held.keys()].map((f) => relPosix(node.projectDir, f)),
      )
    }
    if (additive && write && !deferred && outputs.length > 0) {
      const endStamp = span('miss: stamp outputs')
      if (this.stampedBefore === undefined) this.stampedBefore = await stampOutputs(cleanArgs)
      else {
        const rels = await this.dropFailedAdditions(
          node.projectDir,
          outputs,
          this.stampedBefore,
          cleanArgs.committed,
          await ownOutputsSince(cleanArgs, this.stampedBefore),
          () => resolveOutputs(cleanArgs),
        )
        args.run.gitFilesCache?.markOutputsChanged(node.projectDir, rels)
      }
      endStamp()
    } else if (clean && outputs.length > 0) {
      // Mark the wiped paths, exactly as the workspace twin below does. The
      // git snapshot still lists them with their committed index OIDs, and
      // resolveFiles SKIPS its existence probe for any path carrying a
      // trusted OID: a declared output the producer deletes and does not
      // re-create would stay in a same-project consumer's input set, keeping
      // that consumer's key unchanged while the file is gone from disk.
      const endClean = span('miss: clean outputs')
      const watch = upstreamWrites(args, attempt, node.projectDir)
      const cleanedRels = await cleanOutputs({
        ...cleanArgs,
        beforeRun: true,
        kept: this.committedKept,
        written: watch.written,
      })
      endClean()
      watch.say()
      args.run.gitFilesCache?.markOutputsChanged(node.projectDir, cleanedRels)
      this.committedBefore = this.checkCommitted(
        node.projectDir,
        cleanedRels,
        cleanArgs.committed,
        this.committedBefore,
      )
    } else if (keepOutputs && write && !deferred && outputs.length > 0) {
      this.committedBefore = this.checkCommitted(
        node.projectDir,
        retryCanFollow
          ? (await resolveOutputs(cleanArgs)).map((f) => relPosix(node.projectDir, f))
          : [],
        cleanArgs.committed,
        this.committedBefore,
      )
    }
    if (additive && write && !deferred && wsOutputs.length > 0) {
      // A root-anchored addition is stamped as the project one above: a
      // glob clean deleted the upstream's files before this task, which
      // reads them, ran.
      if (this.wsStampedBefore === undefined)
        this.wsStampedBefore = await stampWorkspaceOutputs(wsCleanArgs)
      else {
        const rels = await this.dropFailedAdditions(
          args.run.workspaceRoot,
          wsOutputs,
          this.wsStampedBefore,
          wsCleanArgs.committed,
          await ownWorkspaceOutputsSince(wsCleanArgs, this.wsStampedBefore),
          () => resolveWorkspaceOutputs(wsCleanArgs),
        )
        args.run.gitFilesCache?.markWorkspaceOutputsChanged(args.run.workspaceRoot, rels)
      }
    } else if (clean && wsOutputs.length > 0) {
      // Root-anchored deletions can land in other projects' dirs; mark
      // them so stale per-project git snapshots can't survive the wipe.
      const watch = upstreamWrites(args, attempt, args.run.workspaceRoot)
      const cleanedWsRels = await cleanWorkspaceOutputs({
        ...wsCleanArgs,
        beforeRun: true,
        kept: this.committedKept,
        written: watch.written,
      })
      watch.say()
      args.run.gitFilesCache?.markWorkspaceOutputsChanged(args.run.workspaceRoot, cleanedWsRels)
      this.wsCommittedBefore = this.checkCommitted(
        args.run.workspaceRoot,
        cleanedWsRels,
        wsCleanArgs.committed,
        this.wsCommittedBefore,
      )
    } else if (keepOutputs && write && !deferred && wsOutputs.length > 0) {
      this.wsCommittedBefore = this.checkCommitted(
        args.run.workspaceRoot,
        retryCanFollow
          ? (await resolveWorkspaceOutputs(wsCleanArgs)).map((f) =>
              relPosix(args.run.workspaceRoot, f),
            )
          : [],
        wsCleanArgs.committed,
        this.wsCommittedBefore,
      )
    }
  }

  /**
   * What an additive run saves as its own, or undefined when it removed a
   * file it found: no entry replays a removal (`ownOutputsSince`), so the
   * task saves nothing and runs again. Undefined too for any task when a
   * failed attempt moved a file no clean removed (`failedTouchedFound`),
   * or the run removed a committed file its clean left (`committedKept`).
   */
  async own(): Promise<OwnOutputs | undefined> {
    if (this.failedTouchedFound) return undefined
    if (this.committedKept.some((f) => lstatSync(f, { throwIfNoEntry: false }) === undefined))
      return undefined
    const mine: OwnOutputs = {}
    const left = this.leftByOwnEntries()
    if (this.stampedBefore !== undefined) {
      const files = await ownOutputsSince(this.cleanArgs, this.stampedBefore, left)
      if (files === undefined) return undefined
      mine.ownOutputFiles = files
    }
    if (this.wsStampedBefore !== undefined) {
      const files = await ownWorkspaceOutputsSince(this.wsCleanArgs, this.wsStampedBefore, left)
      if (files === undefined) return undefined
      mine.ownWsOutputFiles = files
    }
    return mine
  }

  /**
   * Stamps the committed files a clean found before the first attempt, and
   * before a retry taints the save if a failed attempt moved one.
   */
  private checkCommitted(
    root: string,
    rels: readonly string[],
    committed: (abs: string) => boolean,
    before: ReadonlyMap<string, OutputStamp> | undefined,
  ): ReadonlyMap<string, OutputStamp> | undefined {
    if (!this.policy.retryCanFollow) return undefined
    const files = rels.map((r) => path.resolve(root, r))
    if (before === undefined) return stampCommitted(files, committed)
    if (committedMoved(files, committed, before)) this.failedTouchedFound = true
    return before
  }

  /**
   * Whether a file the additive run found and left alone is one a save or
   * restore of this task left there: the proof a hit trusts
   * (`isOutputsCurrent`) against the rows of any of its entries. Read on
   * the first such file only; the upstream's files and what nobody saved
   * have no row of this task's and stay the upstream's.
   */
  private leftByOwnEntries(): (abs: string) => boolean {
    const { args } = this
    const { node } = args
    let byPath: Map<string, Array<[root: string, row: OutputFileRow]>> | undefined
    return (abs) => {
      if (byPath === undefined) {
        byPath = new Map()
        const hashes = taskEntryHashes(args.run.cache, node.id)
        for (const rows of args.run.cache.memo.loadOutputFilesBatch(hashes).values()) {
          for (const row of rows) {
            if (row.ino === undefined) continue
            const ws = row.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
            const root = ws ? args.run.workspaceRoot : node.projectDir
            const rel = ws ? row.path.slice(WORKSPACE_OUTPUT_PREFIX.length) : row.path
            const at = path.join(root, rel)
            const list = byPath.get(at)
            const entry: [string, OutputFileRow] = [root, { ...row, path: rel }]
            if (list === undefined) byPath.set(at, [entry])
            else list.push(entry)
          }
        }
      }
      return (byPath.get(abs) ?? []).some(([root, row]) =>
        args.run.cache.memo.isOutputsCurrent(root, [row]),
      )
    }
  }

  /**
   * Before an additive task's retry: remove what the failed attempt added
   * against the first stamp, as an exclusive task's clean removes it, so
   * the stamp still tells the retry's work from what the task found. A
   * found file it changed or removed stays as it is and taints the save.
   * Returns the removed paths, `root`-relative.
   */
  private async dropFailedAdditions(
    root: string,
    outs: readonly string[],
    before: ReadonlyMap<string, OutputStamp>,
    committed: (abs: string) => boolean,
    changed: string[] | undefined,
    walk: () => Promise<string[]>,
  ): Promise<string[]> {
    const added = (changed ?? (await walk())).filter((f) => !before.has(f))
    if (changed === undefined || added.length < changed.length) this.failedTouchedFound = true
    const rels = added.map((f) => relPosix(root, f))
    if (rels.length > 0)
      await cleanOutputPaths({ projectDir: root, rels, outputs: outs, committed })
    return rels
  }
}

/**
 * What a first attempt's clean deletes that a same-project dependency wrote
 * earlier in this run, collected while it deletes and said after: the
 * config is wrong, and the user is told which task to declare it on.
 * Paths are shown relative to `base` (the project, or the workspace for a
 * root-anchored output).
 */
function upstreamWrites(
  args: ExecuteArgs,
  attempt: number,
  base: string,
): { written: Parameters<typeof cleanOutputs>[0]['written']; say: () => void } {
  const writers = attempt === 1 ? ranBefore(args) : []
  const found = new Map<string, string[]>()
  const { id: self } = args.node
  return {
    written:
      writers.length === 0
        ? undefined
        : {
            windows: writers.map((w) => w.window),
            onWritten: (abs, i) => {
              const id = writers[i]!.id
              let files = found.get(id)
              if (files === undefined) found.set(id, (files = []))
              files.push(relPosix(base, abs))
            },
          },
    say: () => {
      for (const [id, files] of found) {
        const shown =
          files.length > 3
            ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
            : files.join(', ')
        warnOf(args.log)(
          `[vx] ${self}: its outputs' clean before it ran deleted ${shown}, which ${id} wrote earlier in this run ` +
            `— declare ${files.length === 1 ? 'it' : 'them'} in ${id}'s outputs, or have ${id} write outside ${self}'s outputs`,
        )
      }
    },
  }
}

/**
 * The same-project dependencies that ran a command earlier in this run, with
 * their wall-clock windows (ms): a file the clean deletes stamped inside one
 * is that task's write, which the clean is about to take (ngrx: an
 * ng-packagr step with no outputs, then `build` over the same `dist/`).
 */
function ranBefore(args: ExecuteArgs): { id: string; window: readonly [number, number] }[] {
  const out: { id: string; window: readonly [number, number] }[] = []
  const toWall = (ns: bigint, nowWall: number, nowNs: bigint): number =>
    nowWall - Number(nowNs - args.run.runStartHrTimeNs - ns) / 1e6
  const nowWall = Date.now()
  const nowNs = process.hrtime.bigint()
  const seen = new Set<string>()
  const visit = (outcomes: readonly TaskOutcome[]): void => {
    for (const o of outcomes) {
      if (seen.has(o.node.id)) continue
      seen.add(o.node.id)
      if (o.groupUpstream !== undefined) visit(o.groupUpstream)
      const t = o.timing
      if (o.status !== 'success' || o.node.projectDir !== args.node.projectDir) continue
      if (t?.startNs === undefined || t.endNs === undefined || t.endNs <= t.startNs) continue
      out.push({
        id: o.node.id,
        window: [toWall(t.startNs, nowWall, nowNs), toWall(t.endNs, nowWall, nowNs)],
      })
    }
  }
  visit(args.upstream)
  return out
}

// Every declared output is required (M 2026-11-22): a positive glob that
// matches nothing once the command exited 0 fails the task. An empty artifact
// would replay as a build that ran; a pattern against the wrong directory, a
// sandbox with no write grant and an incremental tool that skipped its emit
// all look like this.

const SCAN = { onlyFiles: false, followSymlinks: false, dot: true } as const

/**
 * The positive globs of `globs` (relative to `base`) that match no path a `!`
 * leaves. Each stops at its first match: `dist/**` costs one directory read,
 * not the walk the save does.
 */
export function missingOutputs(
  base: string,
  globs: readonly string[],
  nestedDirs: readonly string[],
): string[] {
  const { positive, negative } = splitNegations(globs)
  if (positive.length === 0) return []
  const takenBack = anyTaskGlob(negative)
  const nested = nestedDirs
    .map((d) => path.relative(base, d))
    .filter((r) => r !== '' && !r.startsWith('..'))
  const kept = (rel: string): boolean =>
    !takenBack(rel) && !nested.some((n) => rel === n || rel.startsWith(`${n}/`))
  const missing: string[] = []
  for (const g of positive) if (!matchesAny(base, g, kept)) missing.push(g)
  return missing
}

function matchesAny(base: string, glob: string, kept: (rel: string) => boolean): boolean {
  for (const tree of asTrees([glob])) {
    if (isLiteralPattern(tree)) {
      if (kept(tree) && exists(path.join(base, tree))) return true
      continue
    }
    // A link to a directory is listed by its own name, which a glob reaching
    // below it does not match: its target holds the outputs.
    const prefix = staticPrefix(tree)
    if (prefix !== '' && kept(prefix) && linksToDir(path.join(base, prefix))) return true
    if (prefix !== '' && !exists(path.join(base, prefix))) continue
    // `dir/**` left empty matched nothing: the clean keeps the root, so an
    // empty one is no sign the command wrote. A literal `dir` is required
    // as itself, and the clean removes it.
    // Synchronous: it stops at the first match, and the async scan's answer
    // waited its turn on a busy run's loop with the task's slot held (1.1 ms
    // a build on the bench's cold run, against 0.05 ms).
    try {
      for (const rel of taskGlob(tree).scanSync({ ...SCAN, cwd: base })) {
        if (rel !== '' && kept(rel)) return true
      }
    } catch {
      // A directory it cannot list holds something: the save names it.
      return true
    }
  }
  return false
}

function staticPrefix(glob: string): string {
  const parts = glob.split('/')
  const i = parts.findIndex((p) => !isLiteralPattern(p))
  return parts.slice(0, i).join('/')
}

function exists(abs: string): boolean {
  try {
    return lstatSync(abs, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

function linksToDir(abs: string): boolean {
  try {
    return (
      lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
      statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true
    )
  } catch {
    return false
  }
}
