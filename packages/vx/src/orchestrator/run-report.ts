// The report every plugin's teardown reads, and the run's own bytes kept
// in a remote that takes its writes (owner 2026-10-15): a failed task's
// log and the files its outputs left (`cache.upload.failures`), and the
// log of a task that saved no entry. Each task's bytes leave when it ends,
// off its path, like its entry's upload (owner 2026-10-16); the run only
// waits for them where it waits for every upload.

import {
  packRunOutputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
  runEntryName,
} from '../cache/index.js'
import type { CiContext } from './run-context.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { relPosix } from '../util/index.js'
import { decodeOutputLog } from './output-log.js'
import type { RunReport, RunReportTask } from './plugin.js'

/** Stores one run entry; resolves whether a remote kept it. */
export type KeepRunEntry = (name: string, bytes: Uint8Array) => Promise<boolean>

export interface RunKeeperArgs {
  readonly runId: string
  readonly workspaceRoot: string
  readonly nestedDirsByProject: ReadonlyMap<string, string[]>
  readonly keep: KeepRunEntry
  /** Whether a failed task's log and outputs are kept (`cache.upload.failures`). */
  readonly failures: boolean
}

/** Whether a run on CI or off it keeps failures, by `cache.upload.failures` (default `'ci'`). */
export function keepsFailures(where: unknown, ci: boolean): boolean {
  const at = where ?? 'ci'
  return at === 'always' || (at === 'ci') === ci
}

/** Concurrent run-entry writes; more queue. */
const KEEP_CONCURRENCY = 8

/** The files `node`'s declared outputs match on disk now, workspace-relative and sorted. */
async function outputsLeft(
  node: TaskNode,
  workspaceRoot: string,
  nestedProjectDirs: string[],
): Promise<string[]> {
  const declared = node.config.cache?.outputs
  if (declared === undefined) return []
  const [own, ws] = await Promise.all([
    resolveOutputs({ projectDir: node.projectDir, outputs: declared.files, nestedProjectDirs }),
    resolveWorkspaceOutputs({ workspaceRoot, outputs: declared.workspaceFiles ?? [] }),
  ])
  return [...new Set([...own, ...ws].map((p) => relPosix(workspaceRoot, p)))].sort()
}

/** Keeps each task's run bytes as it ends, and names them in the run's report. */
export class RunKeeper {
  private readonly kept = new Map<string, { log?: string; outputs?: string }>()
  private readonly queue: (() => Promise<void>)[] = []
  private readonly pending = new Set<Promise<void>>()
  private active = 0
  private stopped = false

  constructor(private readonly args: RunKeeperArgs) {}

  /** A task ended: queue what of it the run keeps. */
  taskDone(o: TaskOutcome): void {
    if (this.stopped || isGroupTask(o.node)) return
    const { runId, workspaceRoot } = this.args
    const id = o.node.id
    const slot = (): { log?: string; outputs?: string } => {
      let s = this.kept.get(id)
      if (s === undefined) this.kept.set(id, (s = {}))
      return s
    }
    const runLog = o.runLog
    if (runLog !== undefined) {
      const text = decodeOutputLog(runLog)
        .map((c) => c.text)
        .join('')
      if (text.length > 0) {
        const name = runEntryName(runId, id, 'log')
        const bytes = new TextEncoder().encode(text)
        this.enqueue(async () => {
          if (await this.args.keep(name, bytes)) slot().log = name
        })
      }
    }
    if (this.args.failures && o.status === 'failed' && o.where === undefined) {
      // Read now: a later task may write where this one's outputs lie.
      const packed = outputsLeft(
        o.node,
        workspaceRoot,
        this.args.nestedDirsByProject.get(o.node.projectName) ?? [],
      ).then((paths) => packRunOutputs(workspaceRoot, paths))
      const name = runEntryName(runId, id, 'outputs')
      this.enqueue(async () => {
        const bytes = await packed
        if (bytes !== null && (await this.args.keep(name, bytes))) slot().outputs = name
      })
    }
  }

  /** Resolves once every queued write has settled, or the run was stopped. */
  async settled(): Promise<void> {
    while (!this.stopped && this.pending.size > 0) await Promise.all(this.pending)
  }

  /** A stopped run starts no more writes and stops waiting on those in flight. */
  stop(): void {
    this.stopped = true
    this.queue.length = 0
  }

  /** What was kept of each task, by id, for `reportOf`. */
  keptOf(id: string): { log?: string; outputs?: string } | undefined {
    return this.kept.get(id)
  }

  private enqueue(job: () => Promise<void>): void {
    let done!: () => void
    const p = new Promise<void>((resolve) => (done = resolve))
    this.pending.add(p)
    this.queue.push(async () => {
      try {
        if (!this.stopped) await job()
      } catch {
        // a record, never the run's verdict
      } finally {
        this.pending.delete(p)
        done()
      }
    })
    this.pump()
  }

  private pump(): void {
    while (this.active < KEEP_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active++
      void job().finally(() => {
        this.active--
        this.pump()
      })
    }
  }
}

/** The report: every task, with the names of what `keeper` kept of it. */
export function reportOf(
  final: readonly TaskOutcome[],
  run: { runId: string; commit: string | null; ciRun: CiContext; ok: boolean },
  keeper: RunKeeper | undefined,
): RunReport {
  const tasks: RunReportTask[] = []
  for (const o of final) {
    if (isGroupTask(o.node)) continue
    const kept = keeper?.keptOf(o.node.id)
    tasks.push({
      id: o.node.id,
      status: o.status,
      durationMs: Math.round(o.durationMs),
      ...(o.hash !== undefined ? { key: o.hash } : {}),
      ...(kept?.log !== undefined ? { log: kept.log } : {}),
      ...(kept?.outputs !== undefined ? { outputs: kept.outputs } : {}),
    })
  }
  return { runId: run.runId, commit: run.commit, ciRun: run.ciRun, ok: run.ok, tasks }
}
