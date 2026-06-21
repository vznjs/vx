-- vx cloud — initial schema (D1 / SQLite).
-- Mirrors docs/design/vx-cloud-2026-06.md §3, adapted to D1.
-- All bigint columns (wallclock ns, cpu ms) stored as INTEGER:
-- SQLite handles 64-bit signed integers natively.

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  org_id      TEXT NOT NULL,
  github_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member', 'ci')),
  PRIMARY KEY (org_id, github_id),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member', 'ci')),
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS api_tokens_org_idx ON api_tokens (org_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  repo                TEXT,
  branch              TEXT,
  commit_sha          TEXT,
  pr_number           INTEGER,
  triggered_by        TEXT,
  ci_provider         TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  exit_code           INTEGER,
  cpu_ms              INTEGER,
  peak_rss_bytes      INTEGER,
  wallclock_start_ns  INTEGER,
  wallclock_end_ns    INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

-- Tenant isolation: every query reads (org_id, …) so org_id leads.
CREATE INDEX IF NOT EXISTS runs_org_started_idx ON runs (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_org_branch_idx  ON runs (org_id, branch, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_org_pr_idx      ON runs (org_id, pr_number) WHERE pr_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_tasks (
  run_id            TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  task_hash         TEXT,
  status            TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'aborted')),
  cache_source      TEXT CHECK (cache_source IN ('miss', 'fresh', 'local', 'remote')),
  duration_ms       INTEGER,
  cpu_ms            INTEGER,
  peak_rss_bytes    INTEGER,
  span_start_ns     INTEGER,
  span_end_ns       INTEGER,
  worker_id         TEXT,
  stdout_artifact   TEXT,
  stderr_artifact   TEXT,
  PRIMARY KEY (run_id, task_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_tasks_hash_idx   ON run_tasks (task_hash);
CREATE INDEX IF NOT EXISTS run_tasks_status_idx ON run_tasks (status);

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts_ns       INTEGER NOT NULL,
  event_json  TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_events_run_ts_idx ON run_events (run_id, ts_ns);
