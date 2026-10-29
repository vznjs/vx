// Stable-key derivation, shared by remote-prefetch and the local
// short-circuit. Both need to identify the tasks whose cache key is
// provably independent of any upstream task's OUTPUTS — those are the
// only tasks safe to probe / restore ahead of the schedule. Factored
// out so the two callers can never drift on the stability gate.
//
// A task's key is "stable" only if its inputs can't be altered by an
// upstream's outputs (a `inputs.files` glob that could match a
// sibling's declared output has a PRELIMINARY key until that upstream
// runs — probing it would target the wrong artifact). Unstable tasks
// fall back to lazy read-through in execute-task, which is always
// correct. The check is conservative: when unsure, treat as unstable.

import {
  foldedDeps,
  isGroupTask,
  outputTakenBack,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import {
  checkIgnore,
  ignoreProbes,
  isLiteralPattern,
  normalizeGlob,
  relPosix,
  taskGlob,
  wholeIgnored,
} from '../util/index.js'
import { commandWriteReach, mayWriteFingerprint, undeclaredWriteReach } from './sandbox-request.js'
import {
  computeGroupHash,
  computeTaskHash,
  type HashCache,
  type UpfrontGroupKey,
} from './task-hash.js'
import { filterUpstreamHashes, keyedOutcome, keyUpstream } from './upstream.js'

export interface DeriveStableKeysArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  /** The root files the plugins claim (`VxPlugin.fingerprint`), for `mayWriteFingerprint`. */
  claimedFiles: readonly string[]
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  /**
   * Filled with each uncached task's key when no upstream can write where
   * that key reads, so execute-task need not derive it a second time.
   */
  uncachedKeys?: Map<string, string>
  /**
   * Filled with each unkeyed group's key and the upstream it folded:
   * execute-task reuses the key when the live upstream matches.
   */
  groupKeys?: Map<string, UpfrontGroupKey>
  /** Filled with every key the walk makes, in the order it makes them (`RunDerivation`). */
  keys?: Map<string, string>
}

export interface StableKey {
  hash: string
  node: TaskNode
}

/**
 * Walk the graph in topological order, deriving every task's key the
 * SAME way execute-task does (folding upstream keys via the synthetic
 * {node, hash} outcomes filterUpstreamHashes / computeGroupHash read)
 * and classifying each as stable / unstable. Returns the stable,
 * cache-enabled, non-group tasks paired with their keys.
 *
 * Reuses the run's `hashCache`, so execute-task's later computeTaskHash
 * for the same node hits the memo (the task config hash, file lists) —
 * the key bytes are derived here, the heavy per-project hashing is
 * shared. No cache layer is touched: keys only.
 */
export async function deriveStableKeys(args: DeriveStableKeysArgs): Promise<StableKey[]> {
  const order = topoOrder(args.nodes)
  const late = probesAfterWrites(args.nodes, args.workspaceRoot)
  const keyById = args.keys ?? new Map<string, string>()
  const unstableById = new Set<string>()
  // Transitive-upstream output producers, accumulated in topo order — the
  // inputs to the stability gate. A task's key is preliminary if an upstream
  // writes where its inputs read, and that reach is TRANSITIVE: a producer
  // reached through a no-output intermediate still poisons the key, so each
  // dep's accumulated producers fold forward.
  //   - outputProjects: the project names of every upstream task declaring
  //     cache.outputs.files (project-relative outputs land in the producer's
  //     own dir), and of every upstream with no cache block that may write
  //     in its own project (`undeclaredWriteReach`, item 743). A bitset over
  //     project indexes: a union per dep was a string Set copied tasks ×
  //     deps × projects times, 101 ms of a 513 ms warm run at 476 packages
  //     (item 744).
  //   - wsOutputUpstream: any upstream declares cache.outputs.workspaceFiles
  //     (root-anchored, boundary-ignoring outputs), or has no cache block
  //     and a sandbox write grant elsewhere in the workspace, or may rewrite
  //     a root file a plugin claims (a root `pnpm install`): every key folds
  //     what the claimant took from it, once per run.
  //   - rewritersById / unfoldedById: the projects of every upstream CACHED
  //     task that may rewrite its own inputs in place (a formatter declaring
  //     no outputs; `commandWriteReach`), and the subset this task's key does
  //     not fold. A key that folds the rewriter's covers what it writes — its
  //     writes are its inputs', which its key names — so only a reader
  //     folding no path to it (`tasks: []`) is preliminary. A rewriter an
  //     unfolded dependency covered is still uncovered here: its key is not
  //     in this one.
  //   - wsRewriters: the same for a cached rewriter whose reach is every
  //     project (a write grant elsewhere in the workspace, or a claimed root
  //     file, `mayWriteFingerprint`); one this key does not fold makes it
  //     preliminary. A dependency this key folds needs no pass-through here:
  //     a keyed task with such a rewriter unfolded is unstable itself, and
  //     instability is inherited below.
  //   - wideById: the subset of outputProjects whose writes are undeclared
  //     (`undeclaredWriteReach`), so they may land anywhere in the project.
  //     A declared-output producer reaches a same-project reader only where
  //     its output globs can meet the reader's inputs (`outputsOf`, A-20).
  const projects = new ProjectIndex(args.nodes)
  const outputProjectsById = new Map<string, ProjectSet>()
  const wideById = new Map<string, ProjectSet>()
  // Every project's declared `outputs.files`, over all its tasks: a superset
  // of what any one reader's upstream producers declare.
  const outputsOf = new Map<string, string[]>()
  for (const n of args.nodes.values()) {
    const files = n.config.cache?.outputs.files ?? []
    if (files.length === 0) continue
    const list = outputsOf.get(n.projectName)
    if (list === undefined) outputsOf.set(n.projectName, [...files])
    else list.push(...files)
  }
  const readableOf = readableOutputs(outputsOf, args.nodes, args.workspaceRoot, args.gitFilesCache)
  const rewritersById = new Map<string, ProjectSet>()
  const unfoldedById = new Map<string, ProjectSet>()
  const wsRewriters = new Set<string>()
  // A cached rewriter matters only to a key that leaves a dependency's key
  // out: a `inputs.tasks` filter. With none in the graph every edge
  // folds and the sets above stay empty, so they are not built (about 2 ms,
  // median, of a 27 ms memoised walk over the 3,000-task bench; item 750).
  let anyUnfolded = false
  for (const n of args.nodes.values()) {
    if (n.config.inputs?.tasks !== undefined) {
      anyUnfolded = true
      break
    }
  }
  const wsOutputUpstreamById = new Map<string, boolean>()
  const upstreamByDeps = new Map<
    string,
    { outputProjects: ProjectSet; wide: ProjectSet | undefined; wsOutputUpstream: boolean }
  >()
  const noProjects = projects.empty()
  const stableKeys: StableKey[] = []
  // Workspace-relative project dirs, for the reach test of a
  // `workspaceFiles` reader against its upstream producers.
  const dirByProject = new Map<string, string>()
  for (const node of args.nodes.values()) {
    if (!dirByProject.has(node.projectName)) {
      dirByProject.set(node.projectName, relPosix(args.workspaceRoot, node.projectDir))
    }
  }

  for (const id of order) {
    const node = args.nodes.get(id)!
    const upstream = synthUpstream(node, args.nodes, keyById)

    // Fold every dep's accumulated producers + the dep's own declared
    // outputs into this node's transitive-upstream producer sets. They
    // depend on the deps alone, and at 5,000 projects a `^build` reader
    // shares its list with its project's group: 61,600 unions of 157-word
    // sets were 52 ms of a warm run, half of them repeats.
    const depsKey = node.deps.length === 1 ? node.deps[0]! : node.deps.join('\0')
    let up = upstreamByDeps.get(depsKey)
    if (up === undefined) {
      const outputs = new Union(projects)
      const wideUnion = new Union(projects)
      let wsOutputUpstream = false
      for (const dep of node.deps) {
        const depNode = args.nodes.get(dep)
        if (!depNode) continue
        const upstreamOfDep = outputProjectsById.get(dep)
        if (upstreamOfDep !== undefined) outputs.addAll(upstreamOfDep)
        const wideOfDep = wideById.get(dep)
        if (wideOfDep !== undefined) wideUnion.addAll(wideOfDep)
        if (wsOutputUpstreamById.get(dep) === true) wsOutputUpstream = true
        const depOut = depNode.config.cache?.outputs
        if ((depOut?.files?.length ?? 0) > 0) outputs.add(depNode.projectName)
        if ((depOut?.workspaceFiles?.length ?? 0) > 0) wsOutputUpstream = true
        // An uncached producer declares no outputs, yet a same-project reader
        // after it (`tasks: []` decouples the key, not the order) read the
        // bytes it wrote: its key taken up front was the pre-producer one, and
        // the fourth run of seeds A,B,B,A replayed B over A (turborepo#13788).
        const reach = undeclaredWriteReach(depNode, args.workspaceRoot)
        if (reach === 'project') {
          outputs.add(depNode.projectName)
          wideUnion.add(depNode.projectName)
        } else if (reach === 'workspace') wsOutputUpstream = true
        if (
          depNode.config.cache === undefined &&
          mayWriteFingerprint(depNode, args.workspaceRoot, args.claimedFiles)
        )
          wsOutputUpstream = true
      }
      up = {
        outputProjects: outputs.result() ?? noProjects,
        wide: wideUnion.result(),
        wsOutputUpstream,
      }
      upstreamByDeps.set(depsKey, up)
    }
    const { outputProjects, wide, wsOutputUpstream } = up
    let rewriters: ProjectSet | undefined
    let unfolded: ProjectSet | undefined
    let folds: ((dep: string) => boolean) | undefined
    let wsRewriter = false
    let wsUnfoldedHere = false
    for (const dep of anyUnfolded ? node.deps : []) {
      const depNode = args.nodes.get(dep)
      if (!depNode) continue
      const cached = depNode.config.cache !== undefined
      // The cached twin: a formatter rewriting its own input ahead of a
      // reader that folds no key of it replayed seed B's build under seed A
      // on the fourth run, the same way (item 750).
      const rewrites = cached ? commandWriteReach(depNode, args.workspaceRoot) : 'none'
      const rewritesWs =
        cached &&
        (rewrites === 'workspace' ||
          mayWriteFingerprint(depNode, args.workspaceRoot, args.claimedFiles))
      const rewritersOfDep = rewritersById.get(dep)
      const wsRewriterOfDep = wsRewriters.has(dep)
      if (
        rewritersOfDep === undefined &&
        rewrites !== 'project' &&
        !wsRewriterOfDep &&
        !rewritesWs
      ) {
        continue
      }
      rewriters ??= projects.empty()
      if (rewritersOfDep !== undefined) rewriters.addAll(rewritersOfDep)
      if (rewrites === 'project') rewriters.add(depNode.projectName)
      if (wsRewriterOfDep || rewritesWs) wsRewriter = true
      folds ??= foldedBy(node, upstream, keyById)
      if (folds(dep)) {
        const unfoldedOfDep = unfoldedById.get(dep)
        if (unfoldedOfDep !== undefined) (unfolded ??= projects.empty()).addAll(unfoldedOfDep)
        continue
      }
      unfolded ??= projects.empty()
      if (rewritersOfDep !== undefined) unfolded.addAll(rewritersOfDep)
      if (rewrites === 'project') unfolded.add(depNode.projectName)
      if (wsRewriterOfDep || rewritesWs) wsUnfoldedHere = true
    }
    outputProjectsById.set(id, outputProjects)
    if (wide !== undefined) wideById.set(id, wide)
    wsOutputUpstreamById.set(id, wsOutputUpstream)
    if (rewriters !== undefined) rewritersById.set(id, rewriters)
    if (unfolded !== undefined) unfoldedById.set(id, unfolded)
    if (wsRewriter) wsRewriters.add(id)

    // Its probes answer only once its writers have run, so it has no key
    // up front, and its dependants inherit that.
    if (late.has(id)) {
      unstableById.add(id)
      continue
    }

    if (isGroupTask(node)) {
      // Groups have no exec/cache; they only fold upstream keys so
      // dependents that filter inputs.tasks through the group still
      // cascade (and forward their producers, above). They inherit
      // instability from any unstable member.
      // `computeGroupKey`, with the unkeyed branch kept synchronous.
      if (node.config.inputs === undefined) {
        const key = computeGroupHash(upstream)
        keyById.set(id, key)
        args.groupKeys?.set(id, { key, upstream })
      } else {
        keyById.set(
          id,
          await computeTaskHash({
            node,
            upstream,
            workspaceRoot: args.workspaceRoot,
            cache: args.cache,
            forwardArgs: args.forwardArgs,
            nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
            gitFilesCache: args.gitFilesCache,
            hashCache: args.hashCache,
          }),
        )
      }
      if (node.deps.some((d) => unstableById.has(d))) unstableById.add(id)
      continue
    }

    const hash = await computeTaskHash({
      node,
      upstream,
      workspaceRoot: args.workspaceRoot,
      cache: args.cache,
      forwardArgs: args.forwardArgs,
      nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
      gitFilesCache: args.gitFilesCache,
      hashCache: args.hashCache,
    })
    keyById.set(id, hash)

    const unstable =
      node.deps.some((d) => unstableById.has(d)) ||
      dependsOnSiblingOutputs(
        node,
        unfolded === undefined ? outputProjects : unfolded.or(outputProjects),
        wsOutputUpstream || wsUnfoldedHere,
        dirByProject,
        {
          wide: unfolded === undefined ? wide : wide === undefined ? unfolded : wide.or(unfolded),
          outputsOf,
          readableOf,
        },
      )
    if (unstable) unstableById.add(id)

    const cacheEnabled = node.config.cache !== undefined
    if (cacheEnabled && !unstable) stableKeys.push({ hash, node })
    // An uncached key stays preliminary behind any upstream that may write
    // into this project, or anywhere: none of its writes is declared.
    else if (
      !cacheEnabled &&
      !unstable &&
      !outputProjects.has(node.projectName) &&
      unfolded?.has(node.projectName) !== true &&
      !wsOutputUpstream &&
      !wsUnfoldedHere
    )
      args.uncachedKeys?.set(id, hash)
  }
  return stableKeys
}

/**
 * The keys `deriveStableKeys` would make, from a derivation under the same
 * graph, configs and ignored outputs (`readRunDelta`): every task's key
 * is the one remembered unless it is `dirty`, and a dirty task's is derived
 * as the walk derives it, over its deps' keys, in the walk's order. Which
 * tasks are stable and which uncached keys are kept are the remembered
 * verdicts: they read only what the global token names. `keys` is updated
 * in place.
 */
export async function rederiveKeys(
  args: Omit<DeriveStableKeysArgs, 'keys' | 'groupKeys'>,
  keys: Map<string, string>,
  dirty: ReadonlySet<string>,
): Promise<void> {
  for (const [id] of keys) {
    if (!dirty.has(id)) continue
    const node = args.nodes.get(id)!
    const upstream = synthUpstream(node, args.nodes, keys)
    keys.set(
      id,
      isGroupTask(node) && node.config.inputs === undefined
        ? computeGroupHash(upstream)
        : await computeTaskHash({
            node,
            upstream,
            workspaceRoot: args.workspaceRoot,
            cache: args.cache,
            forwardArgs: args.forwardArgs,
            nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
            gitFilesCache: args.gitFilesCache,
            hashCache: args.hashCache,
          }),
    )
  }
}

/**
 * A project's positive outputs indexed by literal head, so a reader finds
 * the ones its inputs reach (`workspaceInputsReach`: a head equal to, above
 * or below an input's) without testing each: one project of 9000 tasks
 * tested 81 million pairs, 6 s of a plan (2026-10-25).
 */
class ProjectOutputs {
  private readonly globs: string[] = []
  private readonly byHead = new Map<string, number[]>()
  private sorted: string[] | undefined

  add(glob: string, head: string): void {
    const key = head === '.' ? '' : head
    let at = this.byHead.get(key)
    if (at === undefined) this.byHead.set(key, (at = []))
    at.push(this.globs.length)
    this.globs.push(glob)
    this.sorted = undefined
  }

  /** The globs `inputs` reach, in the order they were added. */
  reachedBy(inputs: readonly string[]): string[] {
    const hit = new Set<number>()
    const take = (head: string) => {
      for (const i of this.byHead.get(head) ?? []) hit.add(i)
    }
    for (const raw of inputs) {
      if (raw.startsWith('!')) continue
      take('')
      const p = literalPrefix(raw)
      if (p === '') return [...this.globs]
      for (let at = p.indexOf('/'); at !== -1; at = p.indexOf('/', at + 1)) take(p.slice(0, at))
      take(p)
      const sorted = (this.sorted ??= [...this.byHead.keys()].sort())
      const from = `${p}/`
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid]! < from) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < sorted.length && sorted[i]!.startsWith(from); i++) take(sorted[i]!)
    }
    return [...hit].sort((a, b) => a - b).map((i) => this.globs[i]!)
  }
}

/**
 * The same-project outputs a reader's inputs reach, root-relative, each with
 * its project dir and project-relative glob: the outputs the gate would key
 * a reader late over, unless git ignores them (`askIgnoredOutputs`).
 */
export function gatedOutputs(
  nodes: ReadonlyMap<string, TaskNode>,
  workspaceRoot: string,
): Map<string, { projectDir: string; glob: string }> {
  const out = new Map<string, { projectDir: string; glob: string }>()
  // Each project's positive outputs with their literal heads, read once:
  // 1,000 projects' tasks spent 5-8 ms here re-splitting the same globs.
  const outputsOf = new Map<string, ProjectOutputs>()
  for (const n of nodes.values()) {
    const files = n.config.cache?.outputs.files
    if (files === undefined || files.length === 0) continue
    let po = outputsOf.get(n.projectName)
    if (po === undefined) outputsOf.set(n.projectName, (po = new ProjectOutputs()))
    for (const glob of files) if (!glob.startsWith('!')) po.add(glob, literalPrefix(glob))
  }
  if (outputsOf.size === 0) return out
  for (const n of nodes.values()) {
    const inputs = n.config.inputs?.files
    const outputs = outputsOf.get(n.projectName)
    if (inputs === undefined || outputs === undefined || isGroupTask(n)) continue
    let back: string[] | undefined
    let rel: string | undefined
    for (const o of outputs.reachedBy(inputs)) {
      rel ??= relPosix(workspaceRoot, n.projectDir)
      back ??= inputs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
      const rooted = rel === '' ? o : `${rel}/${o}`
      if (out.has(rooted) || (back.length > 0 && outputTakenBack(o, back))) continue
      out.set(rooted, { projectDir: n.projectDir, glob: o })
    }
  }
  return out
}

/**
 * Asks git which of `gated` it ignores, started beside the run's
 * enumeration; the call it returns settles `files.ignoredOutputs` once that
 * enumeration is in, whose listing says whether a tracked or re-included
 * file lies under a glob. Nothing gated: no spawn.
 */
export function askIgnoredOutputs(
  gated: ReadonlyMap<string, { projectDir: string; glob: string }>,
  workspaceRoot: string,
): (files: GitFilesCache) => Promise<void> {
  if (gated.size === 0) return async () => {}
  const paths = [...gated.keys()].flatMap((g) => ignoreProbes(g)?.paths ?? [])
  const asked = paths.length === 0 ? Promise.resolve(null) : checkIgnore(workspaceRoot, paths)
  return async (files) => {
    files.ignoredOutputs = wholeIgnored(gated.keys(), await asked, (g) => {
      const { projectDir, glob } = gated.get(g)!
      const listed = files.get(projectDir)
      return listed === undefined || listed.some((f) => taskGlob(glob).match(f))
    })
  }
}

/** `outputsOf` less what git ignores whole; the same map when it ignores none. */
function readableOutputs(
  outputsOf: ReadonlyMap<string, string[]>,
  nodes: ReadonlyMap<string, TaskNode>,
  workspaceRoot: string,
  files: GitFilesCache,
): ReadonlyMap<string, readonly string[]> {
  const ignored = files.ignoredOutputs
  if (ignored.size === 0) return outputsOf
  const dirOf = new Map<string, string>()
  for (const n of nodes.values()) dirOf.set(n.projectName, relPosix(workspaceRoot, n.projectDir))
  const out = new Map<string, readonly string[]>()
  for (const [project, outputs] of outputsOf) {
    const rel = dirOf.get(project)!
    out.set(
      project,
      outputs.filter((o) => !ignored.has(rel === '' ? o : `${rel}/${o}`)),
    )
  }
  return out
}

const probesAfterWritesOf = new WeakMap<ReadonlyMap<string, TaskNode>, ReadonlySet<string>>()

/**
 * The cached tasks whose `inputs.runtime` / `workspaceRuntime` probes
 * may read what an upstream writes this run while the key folds nothing of
 * that upstream (X-34). A probe is a shell command and may read anywhere,
 * so no glob bounds it, and its answer taken before the writer ran is the
 * previous run's bytes. Such a task is never stable (`deriveStableKeys`
 * takes no key for it), and its probes are answered for it alone, after
 * its upstream ran (`ComputeHashArgs.probesAfterWrites`).
 *
 * A writer is any upstream whose command may write (`commandWriteReach`)
 * or that declares outputs. A key that folds the writer's covers what it
 * writes, as for a rewriter in `deriveStableKeys`: an early answer then
 * costs a spurious miss on the run after the bytes change, never a stale
 * hit, and such a probe keeps the run's shared answer — one spawn per run,
 * not per task. So only a writer the key does not fold, transitively
 * (`tasks: []`, a filter that leaves it out, an order-only edge), makes
 * the probe wait.
 *
 * Once per graph: run, admission and both up-front passes ask the same map.
 */
export function probesAfterWrites(
  nodes: ReadonlyMap<string, TaskNode>,
  workspaceRoot: string,
): ReadonlySet<string> {
  const memo = probesAfterWritesOf.get(nodes)
  if (memo !== undefined) return memo
  const late = new Set<string>()
  probesAfterWritesOf.set(nodes, late)
  const probes = (n: TaskNode): boolean =>
    (n.config.inputs?.runtime?.length ?? 0) > 0 ||
    (n.config.inputs?.workspaceRuntime?.length ?? 0) > 0
  let anyProbe = false
  for (const n of nodes.values()) {
    if (probes(n)) {
      anyProbe = true
      break
    }
  }
  if (!anyProbe) return late
  // A sandbox with no write grant still writes the declared outputs. A
  // claimed root file is only writable where `commandWriteReach` is not
  // 'none' already (`mayWriteFingerprint`).
  const writers = new Set<string>()
  for (const n of nodes.values()) {
    if (
      commandWriteReach(n, workspaceRoot) !== 'none' ||
      (n.config.cache?.outputs.files.length ?? 0) > 0 ||
      (n.config.cache?.outputs.workspaceFiles?.length ?? 0) > 0
    )
      writers.add(n.id)
  }
  const nodeOf = (id: string): TaskNode => nodes.get(id)!
  // Any writer runs before the task; one its key does not fold does.
  const writerBelow = new Set<string>()
  const unfoldedBelow = new Set<string>()
  for (const id of topoOrder(nodes)) {
    const node = nodes.get(id)!
    let writer = false
    let unfolded = false
    // No filter and no order-only edge: the key folds every dependency.
    const foldsAll = node.orderOnly === undefined && node.config.inputs?.tasks === undefined
    let folds: Set<string> | undefined
    for (const dep of node.deps) {
      if (!nodes.has(dep)) continue
      const depWrites = writerBelow.has(dep) || writers.has(dep)
      if (depWrites) writer = true
      if (unfolded || !depWrites) continue
      const folded =
        foldsAll || (folds ??= new Set(foldedDeps(node, nodeOf).map((c) => c.node.id))).has(dep)
      unfolded = folded ? unfoldedBelow.has(dep) : true
    }
    if (writer) writerBelow.add(id)
    if (unfolded) unfoldedBelow.add(id)
    if (unfolded && node.config.cache !== undefined && probes(node)) late.add(id)
  }
  return late
}

/**
 * Does this task's key fold the dependency's? What `computeTaskHash` folds
 * (`filterUpstreamHashes` over the same synthetic outcomes); a group folds
 * every keyed member.
 */
function foldedBy(
  node: TaskNode,
  upstream: TaskOutcome[],
  keyById: Map<string, string>,
): (dep: string) => boolean {
  const filter = node.config.inputs?.tasks
  if (isGroupTask(node) || filter === undefined) return (dep) => keyById.has(dep)
  const hashes = new Set(
    filterUpstreamHashes(upstream, filter, node.projectName, node.id).map(([, h]) => h),
  )
  return (dep) => {
    const h = keyById.get(dep)
    return h !== undefined && hashes.has(h)
  }
}

/**
 * Synthetic upstream outcomes for key derivation (`keyedOutcome`).
 */
function synthUpstream(
  node: TaskNode,
  nodes: Map<string, TaskNode>,
  keyById: Map<string, string>,
): TaskOutcome[] {
  const out: TaskOutcome[] = []
  for (const dep of node.deps) {
    const depNode = nodes.get(dep)
    if (!depNode) continue
    out.push(keyedOutcome(depNode, keyById.get(dep)))
  }
  return keyUpstream(node, out)
}

/**
 * Conservative stability check: does any TRANSITIVE-upstream task whose
 * outputs could land where this task reads its inputs make this task's
 * key preliminary? The producers are pre-folded by `deriveStableKeys`
 * (`upstreamOutputProjects` = projects declaring `cache.outputs.files`
 * upstream; `hasWsOutputUpstream` = any `cache.outputs.workspaceFiles`
 * upstream), so a producer reached through a no-output intermediate is
 * caught too.
 *
 *   - Project-relative inputs (default `**` / anything project-relative)
 *     read THIS project's dir, so a same-project upstream's
 *     `outputs.files` — direct or transitive — makes the key
 *     preliminary. Project boundaries are hard, so only SAME-project
 *     outputs can reach a project-relative input.
 *   - `inputs.workspaceFiles` is boundary-free: it can read ANY
 *     project's dir (so any upstream `outputs.files`, in any project,
 *     matters) or a root-anchored location (so any upstream
 *     `outputs.workspaceFiles` matters). Either → preliminary key. This
 *     is the reach the earlier per-dep check missed — it only compared a
 *     dep's `outputs.workspaceFiles`, never a dep's `outputs.files`.
 *
 * Either case → unstable → skip prefetch AND probe reuse (execute-task
 * recomputes the key lazily once the upstream ran). When in doubt,
 * unstable.
 */
export function dependsOnSiblingOutputs(
  node: TaskNode,
  upstreamOutputProjects: ProjectNames,
  hasWsOutputUpstream: boolean,
  dirByProject?: ReadonlyMap<string, string>,
  sameProject?: {
    /** The producers whose writes may land anywhere in their project. */
    wide: ProjectNames | undefined
    /** Each project's declared `outputs.files`, over all its tasks. */
    outputsOf: ReadonlyMap<string, readonly string[]>
    /** The same less what git ignores whole: no key reads those. */
    readableOf?: ReadonlyMap<string, readonly string[]>
  },
): boolean {
  const cache = node.config.cache
  const declared = node.config.inputs
  // A task with no inputs has no key to take up front.
  if (declared === undefined) return false
  if (upstreamOutputProjects.has(node.projectName)) {
    // A same-project producer whose writes are all declared reaches this
    // task's inputs only where the globs can meet: a `test` reading `src/**`
    // after a `build` writing `dist/**` keys the same before and after it,
    // and classing it unstable hashed every such key twice more at 5,000
    // projects (A-20). Undeclared writes, and a rewriter this key does not
    // fold, may land anywhere: those stay project-wide.
    if (sameProject === undefined || sameProject.wide?.has(node.projectName) === true) return true
    const inputs = declared.files
    const outputs = sameProject.outputsOf.get(node.projectName) ?? []
    if (outputs.length === 0) return true
    // An output the reader's own `!` inputs take back whole is not in its
    // key: `['**/*', '!dist/**']` beside a `dist/**` producer keys the same
    // before and after it, which is what `vx lock` asks a config to write
    // (X-54).
    // Nor is an output git ignores whole: a key reads only what git lists.
    // Unless an entry starts inside it (`dist/**`): naming an ignored path
    // makes it an input (`ignoredReach` in cache/inputs.ts).
    const readable = withNamedIgnored(
      inputs,
      outputs,
      sameProject.readableOf?.get(node.projectName) ?? outputs,
    )
    const back = inputs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
    const reach = back.length === 0 ? readable : readable.filter((o) => !outputTakenBack(o, back))
    if (reach.length > 0 && workspaceInputsReach(inputs, reach.map(literalPrefix))) return true
    // Nor where it WRITES inside another task's tree: restored ahead of
    // that producer, its restore raced the producer's clean and extract
    // (M-5; invariant 2 of docs/design/overlapping-outputs-2026-09.md).
    // `outputsOf` holds this task's own globs too; set them aside once.
    const own = cache?.outputs.files ?? []
    if (own.length > 0) {
      const others = [...outputs]
      for (const g of own) {
        const i = others.indexOf(g)
        if (i !== -1) others.splice(i, 1)
      }
      if (others.length > 0 && workspaceInputsReach(own, others.map(literalPrefix))) return true
    }
  }
  // A root-anchored output is boundary-IGNORING by design, so it can land
  // inside THIS task's own project dir — where an ordinary project-relative
  // input reads it. Neither other clause sees that: `upstreamOutputProjects`
  // holds the PRODUCER's project, not this one, and the reader clause below
  // requires this task to read workspace-anchored inputs, which it need not.
  // That gap was a real stale hit (a producer writing `pkgs/app/gen/**` while
  // `app` read `gen/**` project-relative), so the mere presence of a
  // workspace-output producer upstream makes the key preliminary.
  if (hasWsOutputUpstream) return true
  const wsInputs = declared.workspaceFiles ?? []
  if (wsInputs.length > 0 && upstreamOutputProjects.size > 0) {
    // Without the dirs the old answer stands: a workspace reader over any
    // producer is preliminary. With them, only a reader whose globs can
    // reach a producer's directory is. A Turbo-mapped workspace gives every
    // task its `globalDependencies` as root literals (`turbo.json`), which
    // reach no package — classing those as unstable hashed medusa's 83
    // tasks twice and probed 76 of them lazily (2026-09-11).
    if (dirByProject === undefined) return true
    const dirs: string[] = []
    for (const p of upstreamOutputProjects) {
      const d = dirByProject.get(p)
      if (d === undefined) return true
      dirs.push(d)
    }
    return workspaceInputsReach(wsInputs, dirs)
  }
  return false
}

/**
 * `readable`, plus each output git ignores whole that a positive entry of
 * `inputs` starts inside: its literal prefix at or below the output's.
 */
function withNamedIgnored(
  inputs: readonly string[],
  outputs: readonly string[],
  readable: readonly string[],
): readonly string[] {
  if (readable.length === outputs.length) return readable
  const named = outputs.filter((o) => {
    if (readable.includes(o)) return false
    const at = literalPrefix(o)
    if (at === '') return false
    return inputs.some((g) => {
      if (g.startsWith('!')) return false
      const p = literalPrefix(g)
      return p === at || p.startsWith(`${at}/`)
    })
  })
  return named.length === 0 ? readable : [...readable, ...named]
}

/**
 * Can any positive `workspaceFiles` entry match a path inside one of
 * `dirs` (workspace-relative project dirs)? An entry's reach is its
 * literal prefix — the segments before the first one holding a glob
 * metacharacter — and it reaches a dir when either is the other's
 * ancestor or equal. An entry with no literal prefix (`**\/*`) reaches
 * everything. Conservative on every unknown spelling.
 */
export function workspaceInputsReach(
  workspaceFiles: readonly string[],
  dirs: readonly string[],
): boolean {
  for (const raw of workspaceFiles) {
    if (raw.startsWith('!')) continue
    const prefix = literalPrefix(raw)
    if (prefix === '') return true
    for (const dir of dirs) {
      if (dir === '' || dir === '.') return true
      if (prefix === dir || prefix.startsWith(`${dir}/`) || dir.startsWith(`${prefix}/`))
        return true
    }
  }
  return false
}

/** A glob's leading literal segments, `''` when its first holds a wildcard. */
function literalPrefix(glob: string): string {
  let prefix = literalPrefixes.get(glob)
  if (prefix !== undefined) return prefix
  const literal: string[] = []
  for (const seg of normalizeGlob(glob).split('/')) {
    if (!isLiteralPattern(seg)) break
    literal.push(seg)
  }
  literalPrefixes.set(glob, (prefix = literal.join('/')))
  return prefix
}

/** Per glob string, which the configs bound: every task repeats a few. */
const literalPrefixes = new Map<string, string>()

/** What the stability gate reads of a set of project names. */
interface ProjectNames extends Iterable<string> {
  has(name: string): boolean
  readonly size: number
}

/** Every project of the graph, numbered, so a set of them is a bitset. */
class ProjectIndex {
  readonly names: string[] = []
  readonly indexOf = new Map<string, number>()
  readonly words: number

  constructor(nodes: Map<string, TaskNode>) {
    for (const node of nodes.values()) {
      if (this.indexOf.has(node.projectName)) continue
      this.indexOf.set(node.projectName, this.names.length)
      this.names.push(node.projectName)
    }
    this.words = (this.names.length + 31) >>> 5
  }

  empty(): ProjectSet {
    return new ProjectSet(this, new Uint32Array(this.words))
  }
}

class ProjectSet implements ProjectNames {
  constructor(
    private readonly index: ProjectIndex,
    private readonly bits: Uint32Array,
  ) {}

  add(name: string): void {
    const i = this.index.indexOf.get(name)!
    this.bits[i >>> 5]! |= 1 << (i & 31)
  }

  addAll(other: ProjectSet): void {
    for (let w = 0; w < this.bits.length; w++) this.bits[w]! |= other.bits[w]!
  }

  copy(): ProjectSet {
    return new ProjectSet(this.index, this.bits.slice())
  }

  or(other: ProjectSet): ProjectSet {
    const bits = this.bits.slice()
    for (let w = 0; w < bits.length; w++) bits[w]! |= other.bits[w]!
    return new ProjectSet(this.index, bits)
  }

  has(name: string): boolean {
    const i = this.index.indexOf.get(name)
    return i !== undefined && (this.bits[i >>> 5]! & (1 << (i & 31))) !== 0
  }

  get size(): number {
    let n = 0
    for (const word of this.bits) {
      let v = word
      while (v !== 0) {
        v &= v - 1
        n++
      }
    }
    return n
  }

  *[Symbol.iterator](): Iterator<string> {
    for (let i = 0; i < this.index.names.length; i++) {
      if ((this.bits[i >>> 5]! & (1 << (i & 31))) !== 0) yield this.index.names[i]!
    }
  }
}

/** A union that shares its first set until another one would change it. */
class Union {
  private set: ProjectSet | undefined
  private owned = false

  constructor(private readonly index: ProjectIndex) {}

  addAll(other: ProjectSet): void {
    if (this.set === undefined) this.set = other
    else if (this.set !== other) this.own().addAll(other)
  }

  add(name: string): void {
    if (this.set?.has(name) !== true) this.own().add(name)
  }

  result(): ProjectSet | undefined {
    return this.set
  }

  private own(): ProjectSet {
    if (!this.owned) {
      this.set = this.set === undefined ? this.index.empty() : this.set.copy()
      this.owned = true
    }
    return this.set!
  }
}

function topoOrder(nodes: ReadonlyMap<string, TaskNode>): string[] {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes.values()) {
    indegree.set(node.id, node.deps.length)
    for (const dep of node.deps) {
      const list = dependents.get(dep)
      if (list) list.push(node.id)
      else dependents.set(dep, [node.id])
    }
  }
  // Kahn's algorithm with a head pointer instead of `queue.shift()` — a shift
  // reindexes the whole array (O(N) each), making the walk O(N²) on a big
  // graph. `out` doubles as the queue (every dequeued id is already in topo
  // order); we only ever append and advance `head`. Same pattern as
  // computeReverseDepCount / package-graph.
  const out: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) out.push(id)
  for (let head = 0; head < out.length; head++) {
    for (const d of dependents.get(out[head]!) ?? []) {
      const rem = (indegree.get(d) ?? 0) - 1
      indegree.set(d, rem)
      if (rem === 0) out.push(d)
    }
  }
  return out
}
