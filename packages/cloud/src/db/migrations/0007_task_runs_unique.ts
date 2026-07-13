// Per-task incremental ingest (owner 2026-07-13: "report each task same as we
// report result, logs should go together"). A run's task rows can now arrive
// INCREMENTALLY (POST /v1/ingest/task, one per task as it finishes) AND in the
// end-of-run summary batch (POST /v1/ingest, the completeness backstop). To let
// the two converge without duplicating rows, task_runs needs a real idempotency
// key so both paths INSERT ... ON CONFLICT DO NOTHING.
//
// run_id is a globally-unique UUIDv7 and a run declares each (project, task)
// once, so (run_id, project, task) is unique per run. A partitioned unique
// index must include the partition key (started_at) — both ingest paths derive
// started_at identically (run start + the task's wallclock-ns offset), so the
// key matches. Additive: an index over existing, already-unique data.

export const sql = `
CREATE UNIQUE INDEX task_runs_run_project_task
  ON task_runs (started_at, run_id, project, task);
`
