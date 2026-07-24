// Per-task log tails (docs/design/cloud-platform-2026-07.md §5.4). Bounded
// (≤128 KiB/task, failures-first), partitioned monthly by `created_at`.
// (run_id, task_id) uniqueness is enforced app-side by the idempotent ingest
// gate — a cross-partition unique constraint is not expressible and the bytes
// are bounded, so a rare duplicate is a wasted row, not a defect. A DEFAULT
// catch-all partition means an insert never drops.

export const sql = `
CREATE TABLE task_logs (
  org_id         uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  run_id         text NOT NULL,
  task_id        text NOT NULL,
  hash           text,
  status         text NOT NULL,
  codec          text NOT NULL DEFAULT 'plain',
  content        bytea NOT NULL,
  chars_full     int NOT NULL,
  truncated_head int NOT NULL DEFAULT 0,
  created_at     bigint NOT NULL
) PARTITION BY RANGE (created_at);
CREATE TABLE task_logs_default PARTITION OF task_logs DEFAULT;
CREATE INDEX task_logs_ws_run_task ON task_logs (workspace_id, run_id, task_id);
CREATE INDEX task_logs_ws_hash ON task_logs (workspace_id, hash);
`
