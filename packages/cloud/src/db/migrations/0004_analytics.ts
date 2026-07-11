// Analytics hot tables (docs/design/cloud-platform-2026-07.md §5.4): the
// per-invocation + per-task history that P1 kept in the transitional SQLite
// IngestStore. Both are declaratively partitioned by RANGE on `started_at`
// (invocations monthly, task_runs weekly — the 50-100M-rows/day ceiling makes
// monthly task partitions multi-billion-row). A boot + daily maintenance tick
// (db/partitions.ts) creates partitions ahead and DROPs those past retention.
//
// Each parent gets a DEFAULT catch-all partition so an out-of-range insert
// (a backfill, a far-future clock, a period the tick didn't create yet) is
// never dropped. Every hot index LEADS with workspace_id — the tenant clamp
// the auth middleware composes into every WHERE.

export const sql = `
CREATE TABLE invocations (
  run_id            text NOT NULL,
  org_id            uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  command           text NOT NULL,
  requested_tasks   jsonb NOT NULL,
  cache_policy      text NOT NULL,
  concurrency       int NOT NULL,
  flow              text,
  started_at        bigint NOT NULL,
  ended_at          bigint NOT NULL,
  total_duration_ms int NOT NULL,
  task_count        int NOT NULL,
  failed_count      int NOT NULL,
  hit_count         int NOT NULL,
  hit_local_count   int NOT NULL,
  hit_remote_count  int NOT NULL,
  exit_ok           boolean NOT NULL,
  commit_sha        text,
  branch            text,
  dirty             boolean,
  ci                boolean NOT NULL,
  ci_provider       text,
  host              text,
  os                text,
  arch              text,
  vx_version        text NOT NULL,
  tags              jsonb NOT NULL DEFAULT '{}',
  ingested_by_token uuid,
  PRIMARY KEY (started_at, run_id)
) PARTITION BY RANGE (started_at);
CREATE TABLE invocations_default PARTITION OF invocations DEFAULT;
CREATE INDEX invocations_ws_started ON invocations (workspace_id, started_at DESC);
CREATE INDEX invocations_ws_branch_started ON invocations (workspace_id, branch, started_at DESC);
CREATE UNIQUE INDEX invocations_run_id ON invocations (run_id, started_at);

CREATE TABLE task_runs (
  org_id             uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  run_id             text NOT NULL,
  hash               text NOT NULL,
  project            text NOT NULL,
  task               text NOT NULL,
  status             text NOT NULL,
  exit_code          int NOT NULL,
  duration_ms        int NOT NULL,
  started_at         bigint NOT NULL,
  ended_at           bigint NOT NULL,
  cpu_ms             int,
  peak_rss_bytes     bigint,
  wallclock_start_ns bigint,
  wallclock_end_ns   bigint,
  cache_hit          boolean,
  attempts           int
) PARTITION BY RANGE (started_at);
CREATE TABLE task_runs_default PARTITION OF task_runs DEFAULT;
CREATE INDEX task_runs_ws_started ON task_runs (workspace_id, started_at DESC);
CREATE INDEX task_runs_ws_proj_task_started ON task_runs (workspace_id, project, task, started_at DESC);
CREATE INDEX task_runs_ws_hash ON task_runs (workspace_id, hash);
CREATE INDEX task_runs_ws_run ON task_runs (workspace_id, run_id);
`
