// The distributed-run recorder (dist-run-history-2026-07): the seam the
// server-side DistScheduler writes through to land a `VX_CLOUD_DISTRIBUTE` run
// in the Postgres analytics store — so it appears under the dashboard's Runs and
// fills in live, exactly like a local `cloud()` run's `POST /v1/ingest`.

import type { RunSummaryRecord } from '@vzn/vx'
import type { Analytics, TaskIngestRecord } from '../db/analytics.js'
import type { DistRunRecorder } from './scheduler.js'

/**
 * Build the recorder the DistScheduler records through. Both hooks route to the
 * SAME analytics ingest a local run uses (`ingestTask` per task, `ingest` for
 * the header + backstop), scoped to the SUBMITTER's tenant (orgId + an optional
 * workspace-scoped token) — a distributed run records under the submitting
 * token's org/workspace, never another's. Writes are fire-and-forget; a failure
 * is swallowed + warned, since recording is observe-only and must never fail a
 * run (the local sink's rule).
 */
export function makeDistRunRecorder(
  analytics: Analytics,
  principal: { orgId: string; workspaceId?: string | undefined },
  warn: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): DistRunRecorder {
  const { orgId } = principal
  const tokenWorkspaceId = principal.workspaceId
  return {
    taskDone(record: TaskIngestRecord): void {
      void analytics
        .ingestTask({ orgId, tokenWorkspaceId, record })
        .catch((err: unknown) =>
          warn(`vx-cloud: failed to record distributed task: ${errText(err)}`),
        )
    },
    runFinished(summary: RunSummaryRecord): void {
      void analytics
        .ingest({ orgId, tokenWorkspaceId, summary })
        .catch((err: unknown) =>
          warn(`vx-cloud: failed to record distributed run: ${errText(err)}`),
        )
    },
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
