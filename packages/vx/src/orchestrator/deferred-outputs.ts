// The run-scoped registry of tasks whose outputs were left in the remote
// store (`--download=none`), and the lazy materialisation that fetches
// them when a locally-placed task turns out to need them.
//
// See docs/design/download-policy-cas-cache-2026-08.md §5. The two
// invariants that keep this from becoming a second cache:
//
//   - A deferred task writes NOTHING locally — no artifact, no rows. The
//     remote store (the executor's own record) is the entry.
//   - Materialisation CONVERGES: after the bytes land, core runs the
//     ordinary `cache.save`, so the machine is indistinguishable from a
//     `--download=all` run and every later reader (get, prune, verify,
//     metrics) sees one entry shape, not two.

import {
  cleanOutputs,
  resolveOutputs,
  type CacheLayer,
  type GitFilesCache,
} from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'

export interface DeferredEntry {
  /** Fetches this task's outputs onto disk. At-most-once by construction. */
  materialize: () => Promise<void>
  hash: string
  entry: { taskId: string; command: string; durationMs: number; stdout: string }
}

export interface DeferredOutputsArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  /** False when the run's policy writes no local entries. */
  localWrite: boolean
}

export class DeferredOutputs {
  private readonly entries = new Map<string, DeferredEntry>()
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(private readonly args: DeferredOutputsArgs) {}

  register(taskId: string, entry: DeferredEntry): void {
    this.entries.set(taskId, entry)
  }

  /**
   * Task ids whose outputs are still remote — the summary's list. An entry
   * is removed only when materialisation SUCCEEDS, so this covers both
   * "nothing needed them" and "fetching them failed"; the second is
   * precisely when a user needs to be told the tree is not current, and an
   * `inflight` filter here used to hide it.
   */
  pending(): string[] {
    return [...this.entries.keys()].sort()
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Materialise every deferred producer in `node`'s TRANSITIVE dependency
   * closure. Which upstream bytes a command reads is unknowable — that is
   * what `dependsOn` declares — so the whole closure is taken. Each
   * producer materialises at most once per run (memoised on the promise,
   * so two concurrent consumers share one fetch), and they run
   * concurrently.
   *
   * A failure is the CONSUMER's failure: executing against a
   * half-materialised tree is the stale-input class with extra steps, so
   * this throws and the caller fails the task naming the producer.
   */
  async materializeFor(node: TaskNode): Promise<void> {
    const needed: string[] = []
    const seen = new Set<string>()
    const walk = (id: string): void => {
      for (const dep of this.args.nodes.get(id)?.deps ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        if (this.entries.has(dep)) needed.push(dep)
        walk(dep)
      }
    }
    walk(node.id)
    if (needed.length === 0) return
    await Promise.all(needed.map((id) => this.materializeOne(id)))
  }

  private materializeOne(taskId: string): Promise<void> {
    const existing = this.inflight.get(taskId)
    if (existing !== undefined) return existing
    const started = this.run(taskId)
    this.inflight.set(taskId, started)
    return started
  }

  private async run(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId)!
    const producer = this.args.nodes.get(taskId)!
    const outputs = producer.config.cache?.outputs.files ?? []
    const nestedProjectDirs = this.args.nestedDirsByProject.get(producer.projectName) ?? []
    const cleanArgs = { projectDir: producer.projectDir, outputs, nestedProjectDirs }

    // Mirror `restoreHit`'s sequencing so the two paths cannot drift: wipe
    // the declared outputs, write, then tell the git snapshot what moved.
    if (outputs.length > 0) {
      const cleaned = await cleanOutputs(cleanArgs)
      this.args.gitFilesCache?.markOutputsChanged(producer.projectDir, cleaned)
    }
    try {
      await entry.materialize()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `could not fetch deferred outputs of ${taskId}: ${msg} — re-run it with --force, or use --download=all`,
      )
    }
    const outputFiles = await resolveOutputs({
      projectDir: producer.projectDir,
      outputs,
      nestedProjectDirs,
    })
    this.args.gitFilesCache?.markOutputsChanged(
      producer.projectDir,
      outputFiles.map((f) => f.slice(producer.projectDir.length + 1)),
    )
    // Convergence: an ordinary entry, so the next run is a plain local hit
    // and nothing downstream learns a second shape. Policy still governs —
    // a run that writes no local entries writes none here either.
    if (this.args.localWrite) {
      await this.args.cache.save({
        hash: entry.hash,
        projectDir: producer.projectDir,
        outputFiles,
        entry: entry.entry,
      })
    }
    this.entries.delete(taskId)
  }
}
