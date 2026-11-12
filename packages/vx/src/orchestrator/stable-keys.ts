// Stable-key derivation, shared by remote prefetch and the local short-circuit
// so they cannot drift: both need the tasks whose key cannot depend on any
// upstream's outputs, the only ones safe to probe or restore ahead of the
// schedule.
//
// A key is stable only if no upstream's outputs can alter its inputs (an
// `inputs.files` glob that may match a sibling's output has a preliminary key
// until it runs). Unstable tasks fall back to lazy read-through in
// execute-task. When unsure, unstable.

import path from 'node:path'
import {
  foldedDeps,
  isGroupTask,
  outputTakenBack,
  standInsOf,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { type CacheLayer, freshProbe, type GitFilesCache, namedOutright } from '../cache/index.js'
import {
  checkIgnore,
  ignoreProbes,
  isLiteralPattern,
  normalizeGlob,
  relPosix,
  taskGlob,
  wholeIgnored,
} from '../util/index.js'
import {
  commandWriteReach,
  grantedWriteGlobs,
  mayWriteFingerprint,
  undeclaredWriteReach,
} from '../sandbox/index.js'
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
 * Walk the graph in topo order, deriving each task's key as execute-task does
 * and classifying it stable or unstable. Returns the stable, cached, non-group
 * tasks with their keys.
 *
 * Reuses the run's `hashCache`, so execute-task's later hash hits the memo.
 * Touches no cache layer.
 */
export async function deriveStableKeys(args: DeriveStableKeysArgs): Promise<StableKey[]> {
  const order = topoOrder(args.nodes)
  const late = probesAfterWrites(args.nodes, args.workspaceRoot)
  const keyById = args.keys ?? new Map<string, string>()
  const unstableById = new Set<string>()
  // Transitive-upstream output producers in topo order, the stability gate's
  // inputs. The reach is transitive: a producer behind a no-output intermediate
  // still poisons the key.
  // - outputProjects: projects of every upstream declaring `outputs.files`, or
  //   uncached and able to write its own project (`undeclaredWriteReach`). A
  //   bitset: a string Set per dep was 101 ms of a 513 ms warm run.
  // - wsOutputUpstream: any upstream with `outputs.workspaceFiles`, an uncached
  //   one with a write grant elsewhere, or one that may rewrite a
  //   plugin-claimed root file (a root `pnpm install`).
  // - rewritersById / unfoldedById: projects of upstream cached tasks that may
  //   rewrite their own inputs (a formatter; `commandWriteReach`), and the
  //   subset this key does not fold. A key folding the rewriter's covers its
  //   writes, so only a reader folding no path to it (`tasks: []`) is
  //   preliminary.
  // - wsRewriters: the same for a cached rewriter reaching every project
  //   (`mayWriteFingerprint`).
  // - wideById: producers whose writes are undeclared and may land anywhere in
  //   the project (a sandboxed one's only in its grants, `boundedWriters`). A
  //   declared producer reaches a same-project reader only where its globs meet
  //   the reader's (`outputsOf`).
  const projects = new ProjectIndex(args.nodes)
  const outputProjectsById = new Map<string, ProjectSet>()
  const wideById = new Map<string, ProjectSet>()
  // Every project's declared `outputs.files`, over all its tasks: a superset
  // of what any one reader's upstream producers declare.
  const outputsOf = new Map<string, string[]>()
  // And where an uncached sandboxed task's write grants let it write in its
  // project: those writes are bounded like declared outputs, so the task
  // is not one whose writes land anywhere (`grantedWriteGlobs`).
  const boundedWriters = new Set<string>()
  for (const n of args.nodes.values()) {
    let files = n.config.outputs?.files ?? []
    if (
      n.config.exec?.sandbox !== undefined &&
      undeclaredWriteReach(n, args.workspaceRoot) === 'project'
    ) {
      const granted = grantedWriteGlobs(n)
      if (granted !== undefined) {
        boundedWriters.add(n.id)
        files = [...files, ...granted]
      }
    }
    if (files.length === 0) continue
    const list = outputsOf.get(n.projectName)
    if (list === undefined) outputsOf.set(n.projectName, [...files])
    else list.push(...files)
  }
  const readableOf = readableOutputs(outputsOf, args.nodes, args.workspaceRoot, args.gitFilesCache)
  const rewritersById = new Map<string, ProjectSet>()
  const unfoldedById = new Map<string, ProjectSet>()
  const wsRewriters = new Set<string>()
  // A cached rewriter matters only to a key that leaves a dependency out (an
  // `inputs.tasks` filter). With none in the graph the sets stay empty and are
  // not built.
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

    // Fold each dep's accumulated producers and declared outputs into this
    // node's sets. They depend on the deps alone, so a `^build` reader shares
    // its project group's list: at 5,000 projects the repeats were half of 52
    // ms.
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
        const depOut = depNode.config.outputs
        if ((depOut?.files?.length ?? 0) > 0) outputs.add(depNode.projectName)
        if ((depOut?.workspaceFiles?.length ?? 0) > 0) wsOutputUpstream = true
        // An uncached producer declares no outputs, yet a same-project reader
        // after it (`tasks: []` decouples the key, not the order) read what it
        // wrote: the up-front key was the pre-producer one (turborepo#13788).
        const reach = undeclaredWriteReach(depNode, args.workspaceRoot)
        if (reach === 'project') {
          outputs.add(depNode.projectName)
          if (!boundedWriters.has(dep)) wideUnion.add(depNode.projectName)
        } else if (reach === 'workspace') wsOutputUpstream = true
        if (
          depNode.config.cache !== true &&
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
      const cached = depNode.config.cache === true
      // The cached twin: a formatter rewriting its own input ahead of a reader
      // that folds no key of it replayed seed B's build under seed A on the
      // fourth run, the same way.
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
      // Groups only fold upstream keys, so dependents filtering through a group
      // still cascade; they forward producers and inherit any member's
      // instability. `computeGroupKey`, with the unkeyed branch kept
      // synchronous.
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

    const cacheEnabled = node.config.cache === true
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
 * graph, configs and ignored outputs (`readRunDelta`): remembered unless
 * `dirty`; a dirty task's is derived over its deps' keys in walk order.
 * Stability and kept uncached keys are the remembered verdicts. `keys` is
 * updated in place.
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
 * Positive outputs indexed by literal head, so a reader finds those its inputs
 * reach without testing each: one 9,000-task project tested 81 million pairs, 6
 * s of a plan.
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
 * The outputs a reader's inputs reach, root-relative, with project dir and
 * project-relative glob: those the gate would key the reader late over, unless
 * git ignores them (`askIgnoredOutputs`).
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
    const files = n.config.outputs?.files
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
  // A `workspaceFiles` reader reaches other projects' outputs as well, and
  // is keyed late over them unless git ignores them whole too.
  let rootedOutputs: ProjectOutputs | undefined
  const owner = new Map<string, { projectDir: string; glob: string }>()
  for (const n of nodes.values()) {
    const ws = n.config.inputs?.workspaceFiles
    if (ws === undefined || ws.length === 0 || isGroupTask(n)) continue
    if (rootedOutputs === undefined) {
      rootedOutputs = new ProjectOutputs()
      for (const m of nodes.values()) {
        const files = m.config.outputs?.files
        if (files === undefined || files.length === 0) continue
        const rel = relPosix(workspaceRoot, m.projectDir)
        for (const glob of files) {
          if (glob.startsWith('!')) continue
          const rooted = rel === '' ? glob : `${rel}/${glob}`
          if (owner.has(rooted)) continue
          owner.set(rooted, { projectDir: m.projectDir, glob })
          rootedOutputs.add(rooted, literalPrefix(rooted))
        }
      }
    }
    for (const rooted of rootedOutputs.reachedBy(ws))
      if (!out.has(rooted)) out.set(rooted, owner.get(rooted)!)
  }
  return out
}

/**
 * Asks git which of `gated` it ignores, beside the run's enumeration; settles
 * `files.ignoredOutputs` once that is in. Nothing gated: no spawn.
 *
 * The same spawn asks whether git ignores a new file in each directory a task
 * names outright (`namedOutright`), which was a synchronous `check-ignore` on
 * the key path. A probe git refuses (past a symlink, in a submodule) fails the
 * whole spawn, so the outputs are then asked alone and the directories later.
 */
export function askIgnoredOutputs(
  gated: ReadonlyMap<string, { projectDir: string; glob: string }>,
  workspaceRoot: string,
  nodes: ReadonlyMap<string, TaskNode>,
): (files: GitFilesCache) => Promise<void> {
  if (gated.size === 0) return async () => {}
  const paths = [...gated.keys()].flatMap((g) => ignoreProbes(g)?.paths ?? [])
  if (paths.length === 0) return async () => {}
  const dirs = namedDirs(nodes, workspaceRoot)
  const asked: Promise<{ hit: Set<string> | null; dirs: readonly string[] }> =
    dirs.length === 0
      ? checkIgnore(workspaceRoot, paths).then((hit) => ({ hit, dirs }))
      : checkIgnore(workspaceRoot, [...paths, ...dirs.map(freshProbe)]).then(async (hit) =>
          hit !== null ? { hit, dirs } : { hit: await checkIgnore(workspaceRoot, paths), dirs: [] },
        )
  return async (files) => {
    const { hit, dirs: answered } = await asked
    files.ignoredOutputs = wholeIgnored(gated.keys(), hit, (g) => {
      const { projectDir, glob } = gated.get(g)!
      const listed = files.get(projectDir)
      return listed === undefined || listed.some((f) => taskGlob(glob).match(f))
    })
    if (hit !== null && answered.length > 0)
      files.answerNewFilesIgnored(answered, (d) => hit.has(freshProbe(d)))
  }
}

/** Every directory a task's inputs name outright, root-relative, once each; none above the root. */
function namedDirs(nodes: ReadonlyMap<string, TaskNode>, workspaceRoot: string): string[] {
  const out = new Set<string>()
  const seen = new Set<string>()
  for (const n of nodes.values()) {
    if (n.config.inputs === undefined || isGroupTask(n)) continue
    const named = namedOutright(n.config)
    for (const [base, entries] of [
      [n.projectDir, named.files],
      [workspaceRoot, named.workspaceFiles],
    ] as const) {
      for (const e of entries) {
        const at = `${base}\0${e}`
        if (seen.has(at)) continue
        seen.add(at)
        const rel = relPosix(workspaceRoot, path.resolve(base, e))
        if (rel !== '' && !rel.startsWith('../') && !path.isAbsolute(rel)) out.add(rel)
      }
    }
  }
  return [...out]
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
 * Cached tasks whose `inputs.runtime` / `workspaceRuntime` probes may read what
 * an upstream writes this run while the key folds nothing of it. A probe may
 * read anywhere, so an answer taken before the writer ran is the previous
 * run's. Such a task is never stable, and its probes are answered after its
 * upstream ran (`probesAfterWrites`).
 *
 * A writer is any upstream that may write (`commandWriteReach`) or declares
 * outputs. A key folding a cached writer's costs at worst a spurious miss,
 * never a stale hit, so its probe keeps the shared answer (one spawn per run).
 * Only a writer the key does not fold, transitively, or an uncached one makes
 * the probe wait.
 *
 * Once per graph: every pass asks the same map.
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
      (n.config.outputs?.files.length ?? 0) > 0 ||
      (n.config.outputs?.workspaceFiles?.length ?? 0) > 0
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
      // An uncached writer's writes are not a function of its key.
      const covers = folded && (!writers.has(dep) || nodeOf(dep).config.cache === true)
      unfolded = covers ? unfoldedBelow.has(dep) : true
    }
    if (writer) writerBelow.add(id)
    if (unfolded) unfoldedBelow.add(id)
    if (unfolded && node.config.cache === true && probes(node)) late.add(id)
  }
  return late
}

/**
 * Does this task's key fold the dependency's? What `computeTaskHash` folds; an
 * unkeyed group folds every keyed member. A keyed group has its filter: read as
 * folding everything, its `tasks: []` hid a cached rewriter and its reader
 * restored the pre-rewrite key.
 */
function foldedBy(
  node: TaskNode,
  upstream: TaskOutcome[],
  keyById: Map<string, string>,
): (dep: string) => boolean {
  const filter = node.config.inputs?.tasks
  if (filter === undefined) return (dep) => keyById.has(dep)
  const hashes = new Set(
    filterUpstreamHashes(upstream, filter, node.projectName, node.id, standInsOf(node)).map(
      ([, h]) => h,
    ),
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
 * Does any transitive-upstream producer whose outputs could land where this
 * task reads make its key preliminary? Producers are pre-folded by
 * `deriveStableKeys`, so one behind a no-output intermediate is caught.
 * - Project-relative inputs read this project's dir, so only a same-project
 *   `outputs.files` producer reaches them (boundaries are hard).
 * - `inputs.workspaceFiles` is boundary-free: any project's `outputs.files` or
 *   any `outputs.workspaceFiles` may reach it. Unstable means no prefetch and
 *   no probe reuse; execute-task keys lazily after the upstream ran. When in
 *   doubt, unstable.
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
  const declared = node.config.inputs
  // A task with no inputs has no key to take up front.
  if (declared === undefined) return false
  if (upstreamOutputProjects.has(node.projectName)) {
    // A same-project producer with all writes declared reaches these inputs
    // only where the globs meet: `test` over `src/**` after `build` writing
    // `dist/**` keys the same either way (classing it unstable hashed every
    // such key twice more at 5,000 projects). Undeclared writes, and an
    // unfolded rewriter, stay project-wide.
    if (sameProject === undefined || sameProject.wide?.has(node.projectName) === true) return true
    const inputs = declared.files
    const outputs = sameProject.outputsOf.get(node.projectName) ?? []
    if (outputs.length === 0) return true
    // An output the reader's own `!` inputs take back whole is not in its key,
    // nor one git ignores whole (a key reads only what git lists), unless an
    // entry starts inside it (`ignoredReach` in cache/inputs.ts).
    const readable = withNamedIgnored(
      inputs,
      outputs,
      sameProject.readableOf?.get(node.projectName) ?? outputs,
    )
    const back = inputs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
    const reach = back.length === 0 ? readable : readable.filter((o) => !outputTakenBack(o, back))
    if (reach.length > 0 && workspaceInputsReach(inputs, reach.map(literalPrefix))) return true
    // Nor where it writes inside another task's tree: restored ahead of that
    // producer, it raced the producer's clean and extract (invariant 2,
    // docs/design/overlapping-outputs-2026-09.md). `outputsOf` holds this
    // task's own globs; set them aside once.
    const own = node.config.outputs?.files ?? []
    if (own.length > 0) {
      const others = [...outputs]
      for (const g of own) {
        const i = others.indexOf(g)
        if (i !== -1) others.splice(i, 1)
      }
      if (others.length > 0 && workspaceInputsReach(own, others.map(literalPrefix))) return true
    }
  }
  // A root-anchored output ignores boundaries, so it can land in this task's
  // own dir, where a project-relative input reads it; neither other clause sees
  // that. That gap was a real stale hit (`pkgs/app/gen/**` written, `gen/**`
  // read by app), so any workspace-output producer upstream makes the key
  // preliminary.
  if (hasWsOutputUpstream) return true
  const wsInputs = declared.workspaceFiles ?? []
  if (wsInputs.length > 0 && upstreamOutputProjects.size > 0) {
    // Without dirs, a workspace reader over any producer is preliminary; with
    // them, only one whose globs reach a producer's directory. Turbo-mapped
    // `globalDependencies` root literals reach no package (medusa: 83 tasks
    // hashed twice).
    if (dirByProject === undefined) return true
    // A producer with all writes declared reaches the reader only where its
    // outputs meet the globs, and not through an output git ignores whole that
    // no entry names: vueuse's readers keyed late over an ignored `index.json`.
    // Undeclared writes: the whole project dir.
    const heads: string[] = []
    for (const p of upstreamOutputProjects) {
      const d = dirByProject.get(p)
      if (d === undefined) return true
      const outputs = sameProject?.outputsOf.get(p)
      if (
        sameProject === undefined ||
        sameProject.wide?.has(p) === true ||
        outputs === undefined ||
        outputs.length === 0
      ) {
        heads.push(d)
        continue
      }
      const rooted = (o: string): string => (d === '' || d === '.' ? o : `${d}/${o}`)
      const all = outputs.filter((o) => !o.startsWith('!')).map(rooted)
      const readable = (sameProject.readableOf?.get(p) ?? outputs)
        .filter((o) => !o.startsWith('!'))
        .map(rooted)
      for (const o of withNamedIgnored(wsInputs, all, readable)) heads.push(literalPrefix(o))
    }
    return workspaceInputsReach(wsInputs, heads)
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
 * Can a positive `workspaceFiles` entry match a path in one of `dirs`? Its
 * reach is its literal prefix (segments before the first glob); it reaches a
 * dir when either is the other's ancestor or equal. No prefix (`**\/*`) reaches
 * everything. Conservative on unknown spellings.
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
  // Kahn's with a head pointer: `queue.shift()` reindexes the array, O(N²) on a
  // big graph. `out` doubles as the queue.
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
