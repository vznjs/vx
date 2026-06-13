// Upfront cache classification.
//
// Pure-input transitive keys (v22) made every task's cache key
// computable before any execution: a task's key folds its OWN inputs
// plus its upstreams' KEYS, never upstream OUTPUT. So we can walk the
// graph once in topological order, derive every key, batch-probe the
// local cache, and tell the user the FULL cache breakdown
// (miss · up-to-date · local) BEFORE a single task runs — instead of
// the meter dribbling in as the scheduler reaches each node.
//
// The classification is REUSED by execution: execute-task takes the
// precomputed key for any task whose inputs are provably stable, so
// this is not double work. The load-bearing caveat: a task whose
// `cache.inputs.files` globs can match an UPSTREAM's declared output
// (e.g. `inputs: ['**/*']` over a dir an upstream writes
// `generated.txt` into) has inputs that aren't final until that
// upstream runs. Its upfront key is PRELIMINARY — best-effort for the
// meter — and execute-task recomputes it mid-run once upstreams have
// materialized. The flag also propagates downstream: a task folding a
// preliminary upstream key is itself preliminary. We detect the
// overlap conservatively (`globsCanOverlap`); when unsure, we flag.
// Correctness over the optimization.

import { WORKSPACE_OUTPUT_PREFIX } from '../cache/index.js'
import type { CacheConfig } from '../config.js'
import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { computeGroupHash, computeTaskHash, type HashCache } from './task-hash.js'

/** What an upfront probe concluded about one task's cache state. */
export type ClassifiedStatus =
  | 'miss' // no local entry — would execute (may still be a remote hit; see run.ts)
  | 'up-to-date' // local entry + outputs already current on disk
  | 'restored-local' // local entry, needs materialize
  | 'no-cache' // caching disabled for this task (no cache block or --no-cache)
  | 'group' // no exec; aggregator only

export interface ClassifiedTask {
  /** Upfront-derived cache key. PRELIMINARY when `needsRecompute`. */
  key: string
  status: ClassifiedStatus
  /**
   * True when this task's key can only be finalized after an upstream
   * materializes its outputs (or it folds an upstream whose own key is
   * preliminary) — execute-task must recompute the key mid-run rather
   * than trust the upfront one. The upfront `key`/`status` for such a
   * task is best-effort for the meter.
   */
  needsRecompute: boolean
}

/** Baseline cache-meter counts the logger renders before execution. */
export interface CacheClassification {
  miss: number
  upToDate: number
  restoredLocal: number
  byId: Map<string, ClassifiedTask>
}

export interface ClassifyArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  noCache: boolean
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}

/**
 * Compute every task's cache key in topological order (folding
 * upstream KEYS, not outcomes) and batch-probe the local cache to
 * classify each task. Reuses the run-scoped `hashCache` so the
 * scheduler's later key derivation for stable-input tasks hits the
 * memo. Pure read: the only side effect is `cache.get`'s accessed_at
 * bump, identical to the plan path.
 */
export async function classifyTasks(args: ClassifyArgs): Promise<CacheClassification> {
  const { nodes } = args
  const order = topoOrder(nodes)
  const keyById = new Map<string, string>()
  const recomputeById = computeRecomputeFlags(nodes, order)

  // Derive keys in topological order so an upstream's key is in hand
  // before a dependent folds it in. We build a minimal synthetic
  // {node, hash} TaskOutcome for each upstream from `keyById` — that's
  // all `filterUpstreamHashes` / `computeGroupHash` read.
  for (const id of order) {
    const node = nodes.get(id)!
    const upstream = syntheticUpstream(node, nodes, keyById)
    if (isGroupTask(node)) {
      keyById.set(id, computeGroupHash(upstream))
      continue
    }
    const key = await computeTaskHash({
      node,
      upstream,
      workspaceRoot: args.workspaceRoot,
      workspaceFingerprint: args.workspaceFingerprint,
      cache: args.cache,
      forwardArgs: args.forwardArgs,
      nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
      gitFilesCache: args.gitFilesCache,
      hashCache: args.hashCache,
    })
    keyById.set(id, key)
  }

  // Batch-probe the local cache for every cached task's key. The
  // output-file fingerprints come from one SQL pass per task via
  // loadOutputFilesBatch; isOutputsCurrent does the per-task stat
  // check (skipped for tasks with no declared outputs — they're
  // vacuously up-to-date on a hit).
  const byId = new Map<string, ClassifiedTask>()
  let miss = 0
  let upToDate = 0
  let restoredLocal = 0

  for (const node of nodes.values()) {
    const id = node.id
    const key = keyById.get(id)!
    const needsRecompute = recomputeById.get(id) ?? false
    if (isGroupTask(node)) {
      byId.set(id, { key, status: 'group', needsRecompute: false })
      continue
    }
    const cacheCfg: CacheConfig | undefined = node.config.cache
    const cacheEnabled = cacheCfg !== undefined && !args.noCache
    if (!cacheEnabled) {
      byId.set(id, { key, status: 'no-cache', needsRecompute })
      continue
    }

    const hit = await args.cache.get(key, {
      taskId: id,
      command: node.config.exec?.command ?? '',
    })
    if (!hit) {
      miss++
      byId.set(id, { key, status: 'miss', needsRecompute })
      continue
    }

    const outputs = cacheCfg.outputs.files ?? []
    const wsOutputs = cacheCfg.outputs.workspaceFiles ?? []
    const anyOutputs = outputs.length > 0 || wsOutputs.length > 0
    let current = true
    if (anyOutputs) {
      const expected = args.cache.loadOutputFilesBatch([key]).get(key) ?? []
      const projExpected = expected.filter((e) => !e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
      const wsExpected = expected
        .filter((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
        .map((e) => ({ ...e, path: e.path.slice(WORKSPACE_OUTPUT_PREFIX.length) }))
      current =
        expected.length > 0 &&
        (await args.cache.isOutputsCurrent(node.projectDir, projExpected)) &&
        (await args.cache.isOutputsCurrent(args.workspaceRoot, wsExpected))
    }
    if (!anyOutputs || current) {
      upToDate++
      byId.set(id, { key, status: 'up-to-date', needsRecompute })
    } else {
      restoredLocal++
      byId.set(id, { key, status: 'restored-local', needsRecompute })
    }
  }

  return { miss, upToDate, restoredLocal, byId }
}

/**
 * Kahn topological order over dependency edges (deps before
 * dependents). The graph builder already inserts nodes in topo order,
 * but the classification's correctness must not hinge on that
 * unstated property — we sweep explicitly.
 */
function topoOrder(nodes: Map<string, TaskNode>): string[] {
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
  const queue: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const d of dependents.get(id) ?? []) {
      const rem = indegree.get(d)! - 1
      indegree.set(d, rem)
      if (rem === 0) queue.push(d)
    }
  }
  return order
}

/**
 * Build the minimal synthetic upstream outcome list a node's hash
 * derivation reads — only `node` and `hash` are consulted by
 * `filterUpstreamHashes` / `computeGroupHash`. Missing keys (none, by
 * topo order) are skipped.
 */
function syntheticUpstream(
  node: TaskNode,
  nodes: Map<string, TaskNode>,
  keyById: Map<string, string>,
): TaskOutcome[] {
  const out: TaskOutcome[] = []
  for (const depId of node.deps) {
    const depNode = nodes.get(depId)
    const hash = keyById.get(depId)
    if (!depNode || hash === undefined) continue
    out.push({ node: depNode, status: 'success', exitCode: 0, durationMs: 0, hash })
  }
  return out
}

/**
 * Decide, for every node (in topo order), whether execute-task must
 * recompute its key mid-run. A node is flagged iff:
 *   (a) one of its direct in-scope upstreams declares outputs whose
 *       paths could fall under this node's input globs — its inputs
 *       aren't final until that upstream writes; OR
 *   (b) any of its direct upstreams is itself flagged — folding a
 *       preliminary upstream KEY makes this node's key preliminary too.
 *
 * Conservative by construction: when an overlap CAN'T be ruled out we
 * flag. Topo order guarantees a dependency's flag is final before its
 * dependent reads it.
 */
function computeRecomputeFlags(
  nodes: Map<string, TaskNode>,
  order: readonly string[],
): Map<string, boolean> {
  const flags = new Map<string, boolean>()
  for (const id of order) {
    const node = nodes.get(id)!
    let flagged = false
    for (const depId of node.deps) {
      if (flags.get(depId) === true) {
        flagged = true
        break
      }
    }
    if (!flagged) flagged = directUpstreamOutputFeedsInput(node, nodes)
    flags.set(id, flagged)
  }
  return flags
}

function directUpstreamOutputFeedsInput(node: TaskNode, nodes: Map<string, TaskNode>): boolean {
  const cacheCfg: CacheConfig | undefined = node.config.cache
  if (cacheCfg === undefined) return false
  // Input globs that resolve project-relative. `undefined` → the
  // default `['**/*']`, which matches anything in the project.
  const inputGlobs = cacheCfg.inputs.files ?? ['**/*']
  const positiveInputs = inputGlobs.filter((g) => !g.startsWith('!'))
  const wsInputs = (cacheCfg.inputs.workspaceFiles ?? []).filter((g) => !g.startsWith('!'))

  for (const depId of node.deps) {
    const up = nodes.get(depId)
    if (!up) continue
    const upCache: CacheConfig | undefined = up.config.cache
    if (upCache === undefined) continue
    const upOutputs = upCache.outputs.files ?? []
    const upWsOutputs = upCache.outputs.workspaceFiles ?? []

    // Same-project upstream: its project-relative outputs land in the
    // SAME project dir, so this node's project-relative input globs can
    // reach them. (Cross-project outputs land elsewhere — the hard
    // project boundary keeps project-relative inputs out.)
    if (
      up.projectName === node.projectName &&
      upOutputs.length > 0 &&
      globsCanOverlap(positiveInputs, upOutputs)
    ) {
      return true
    }
    // Workspace-anchored outputs can land anywhere — inside this
    // project's dir, or under a node's workspaceFiles input scope.
    // Conservative: any upstream workspace output + this node having
    // ANY non-empty input scope (project or workspace) → recompute.
    if (upWsOutputs.length > 0 && (wsInputs.length > 0 || positiveInputs.length > 0)) {
      return true
    }
  }
  return false
}

/**
 * Could any input glob match a file produced by any output glob?
 * Conservative: any input glob containing `**` (or the whole-tree
 * `*`) reaches everything in the project. Otherwise we test the
 * output's literal static prefix against the input glob and the
 * shared-prefix relationship both ways. Returns false ONLY when no
 * overlap is possible.
 */
function globsCanOverlap(inputGlobs: readonly string[], outputGlobs: readonly string[]): boolean {
  for (const input of inputGlobs) {
    if (input === '*' || input.includes('**')) return true
    const inGlob = new Bun.Glob(input)
    const inStatic = staticPrefix(input)
    for (const output of outputGlobs) {
      const outStatic = staticPrefix(output)
      // The output's literal portion is a concrete path the task will
      // write (or a dir it writes under). If the input glob matches
      // it, they overlap.
      if (inGlob.match(outStatic)) return true
      // Input glob's literal prefix is at/above the output path:
      // `src/**` vs output `src/gen.ts`.
      if (inStatic !== '.' && (outStatic === inStatic || outStatic.startsWith(inStatic + '/'))) {
        return true
      }
      // Both sides wildcarded and their literal regions nest — can't
      // rule out overlap.
      if (input.includes('*') && output.includes('*') && sharePrefix(inStatic, outStatic)) {
        return true
      }
    }
  }
  return false
}

function sharePrefix(a: string, b: string): boolean {
  if (a === '.' || b === '.') return true
  return a.startsWith(b) || b.startsWith(a)
}

/** Longest leading path segment of a glob with no wildcard chars. */
function staticPrefix(glob: string): string {
  const wildcardIdx = glob.search(/[*?[\]]/)
  if (wildcardIdx === -1) return glob
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep)
}
