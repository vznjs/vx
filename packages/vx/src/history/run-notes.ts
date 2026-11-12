// What a run said that its `runs` rows do not hold, for `vx last`: the steps
// it did not wait on (`vx:prefetch`, 2026-10-16), which never show in a
// run's output; its warnings, which scroll past on a terminal (an agent
// reading the run afterwards saw only the footer's count, 2026-10-28); and
// each failed task's output and the files it names. Rows of cache.db's
// `steps`, `warnings` and `failures` (v50; files under the cache dir
// before), so `vx last --sql` reads them too. The newest `KEPT` runs that
// had any are kept, per table. A run with none writes nothing.

import type { Database } from 'bun:sqlite'

/** Runs whose steps, warnings or failures are kept; run ids are UUIDv7, so they sort by age. */
const KEPT = 50

/** One of vx's own steps that ran beside the tasks. */
export interface RunStep {
  id: string
  durationMs: number
  ok: boolean
}

/** A failed task's kept output: plain, bounded, secrets masked. */
export interface KeptFailure {
  taskId: string
  inputMoved?: string
  output: string
  locations: readonly unknown[]
  sandboxFix?: unknown
}

export interface RunNotes {
  readonly steps?: readonly RunStep[]
  readonly warnings?: readonly string[]
  readonly failures?: readonly KeptFailure[]
}

/** Drop every row of `table` older than its newest `KEPT` runs. */
function trim(db: Database, table: 'steps' | 'warnings' | 'failures'): void {
  db.query(
    `DELETE FROM ${table} WHERE run_id < (SELECT run_id FROM (SELECT DISTINCT run_id FROM ${table} ORDER BY run_id DESC LIMIT 1 OFFSET ${KEPT - 1}))`,
  ).run()
}

/** Write `notes` for `runId` in one transaction, then keep the newest `KEPT` runs of each table written. */
export function keepRunNotes(db: Database, runId: string, notes: RunNotes): void {
  const steps = notes.steps ?? []
  const warnings = notes.warnings ?? []
  const failures = notes.failures ?? []
  if (steps.length + warnings.length + failures.length === 0) return
  db.transaction(() => {
    if (steps.length > 0) {
      const insert = db.query(
        'INSERT OR REPLACE INTO steps(run_id, seq, step, duration_ms, ok) VALUES (?, ?, ?, ?, ?)',
      )
      steps.forEach((s, i) => insert.run(runId, i, s.id, Math.round(s.durationMs), s.ok ? 1 : 0))
      trim(db, 'steps')
    }
    if (warnings.length > 0) {
      const insert = db.query('INSERT OR REPLACE INTO warnings(run_id, seq, text) VALUES (?, ?, ?)')
      warnings.forEach((w, i) => insert.run(runId, i, w))
      trim(db, 'warnings')
    }
    if (failures.length > 0) {
      const insert = db.query(
        `INSERT OR REPLACE INTO failures(run_id, task_id, input_moved, output, locations, sandbox_fix)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const f of failures) {
        insert.run(
          runId,
          f.taskId,
          f.inputMoved ?? null,
          f.output,
          JSON.stringify(f.locations),
          f.sandboxFix === undefined ? null : JSON.stringify(f.sandboxFix),
        )
      }
      trim(db, 'failures')
    }
  }).immediate()
}

/** The background steps `runId` kept, in the order they ended; none when it had none. */
export function keptSteps(db: Database, runId: string): RunStep[] {
  const rows = db
    .query('SELECT step, duration_ms, ok FROM steps WHERE run_id = ? ORDER BY seq')
    .all(runId) as { step: string; duration_ms: number; ok: number }[]
  return rows.map((r) => ({ id: r.step, durationMs: r.duration_ms, ok: r.ok === 1 }))
}

/** The warnings `runId` said, colour stripped; none when it said none. */
export function keptWarnings(db: Database, runId: string): string[] {
  const rows = db.query('SELECT text FROM warnings WHERE run_id = ? ORDER BY seq').all(runId) as {
    text: string
  }[]
  return rows.map((r) => r.text)
}

/** What `runId` kept of its failed tasks, by task id; empty when it kept none. */
export function keptFailures(db: Database, runId: string): Map<string, KeptFailure> {
  const rows = db
    .query(
      'SELECT task_id, input_moved, output, locations, sandbox_fix FROM failures WHERE run_id = ?',
    )
    .all(runId) as {
    task_id: string
    input_moved: string | null
    output: string
    locations: string
    sandbox_fix: string | null
  }[]
  const kept = new Map<string, KeptFailure>()
  for (const r of rows) {
    kept.set(r.task_id, {
      taskId: r.task_id,
      ...(r.input_moved !== null ? { inputMoved: r.input_moved } : {}),
      output: r.output,
      locations: JSON.parse(r.locations) as unknown[],
      ...(r.sandbox_fix !== null ? { sandboxFix: JSON.parse(r.sandbox_fix) as unknown } : {}),
    })
  }
  return kept
}
