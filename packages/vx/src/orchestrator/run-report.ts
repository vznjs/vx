// The report every plugin's teardown reads, and the run's own bytes kept
// in a remote that takes its writes (owner 2026-10-15): a failed task's
// log and the files its outputs left, an uncached task's log.

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

export interface RunReportArgs {
  readonly runId: string
  readonly commit: string | null
  readonly ciRun: CiContext
  readonly ok: boolean
  readonly workspaceRoot: string
  readonly nestedDirsByProject: ReadonlyMap<string, string[]>
  /** Stores one run entry; undefined when no remote takes the run's writes. */
  readonly keep: ((name: string, bytes: Uint8Array) => Promise<boolean>) | undefined
}

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

export async function keepRunBytes(
  final: readonly TaskOutcome[],
  args: RunReportArgs,
): Promise<RunReport> {
  const { keep, runId, workspaceRoot } = args
  const tasks: RunReportTask[] = []
  const work: (() => Promise<void>)[] = []
  for (const o of final) {
    if (isGroupTask(o.node)) continue
    const task: { -readonly [K in keyof RunReportTask]: RunReportTask[K] } = {
      id: o.node.id,
      status: o.status,
      durationMs: Math.round(o.durationMs),
      ...(o.hash !== undefined ? { key: o.hash } : {}),
    }
    tasks.push(task)
    if (keep === undefined) continue
    const runLog = o.runLog
    if (runLog !== undefined) {
      work.push(async () => {
        const text = decodeOutputLog(runLog)
          .map((c) => c.text)
          .join('')
        if (text.length === 0) return
        const name = runEntryName(runId, o.node.id, 'log')
        if (await keep(name, new TextEncoder().encode(text))) task.log = name
      })
    }
    if (o.status === 'failed' && o.where === undefined) {
      work.push(async () => {
        const bytes = await packRunOutputs(
          workspaceRoot,
          await outputsLeft(
            o.node,
            workspaceRoot,
            args.nestedDirsByProject.get(o.node.projectName) ?? [],
          ),
        )
        if (bytes === null) return
        const name = runEntryName(runId, o.node.id, 'outputs')
        if (await keep(name, bytes)) task.outputs = name
      })
    }
  }
  for (let i = 0; i < work.length; i += 8) {
    await Promise.all(work.slice(i, i + 8).map((w) => w()))
  }
  return { runId, commit: args.commit, ciRun: args.ciRun, ok: args.ok, tasks }
}
