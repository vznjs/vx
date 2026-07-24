// Output fingerprints (docs/design/cloud-platform-2026-07.md §5.4;
// verify-cross-machine §3): small, unpartitioned. One row per
// (workspace, cache key, os, arch, tree) — the PK makes re-delivery
// idempotent, a deterministic task costs one row per platform forever, and a
// task reporting two trees on the SAME platform accumulates both rows (the
// same-platform nondeterminism signal). Divergence is computed at READ time.

export const sql = `
CREATE TABLE output_fingerprints (
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL,
  hash         text NOT NULL,
  os           text NOT NULL,
  arch         text NOT NULL,
  tree         text NOT NULL,
  file_count   int NOT NULL,
  files        jsonb,
  truncated    boolean NOT NULL DEFAULT false,
  task_id      text NOT NULL,
  run_id       text NOT NULL,
  host         text,
  created_at   bigint NOT NULL,
  PRIMARY KEY (workspace_id, hash, os, arch, tree)
);
CREATE INDEX output_fingerprints_ws_created ON output_fingerprints (workspace_id, created_at);
`
