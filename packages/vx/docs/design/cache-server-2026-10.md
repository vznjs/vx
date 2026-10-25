# The vx cache server (`@vzn/vx-cache-server`), 2026-10

A server anyone hosts that keeps vx's artifacts and run history, so a
fresh CI runner or a new branch starts warm and knows how long each task
takes. It is optional: a workspace that declares no plugin for it never
talks to it, and Turbo-wire, Nx-wire and REAPI remotes stay. Each item
below is marked shipped or planned, and this page changes in the same PR
as the item it describes.

## Shape

- Shipped: one fetch handler (`src/server.ts`) over two seams, `Blobs`
  and `Db`, so both backends share every route and query: Bun with an
  S3-compatible bucket (Bun's S3 client) and a SQLite file (bun:sqlite),
  and Workers with R2 and D1. One conformance suite
  (`tests/conformance.ts`) runs against both; the Worker runs in workerd
  (miniflare), the bucket is an in-memory S3 that Bun's own client talks to.
- Shipped: our own wire, versioned by path (`/v1/...`, PROTOCOL.md), not
  Turbo's. Standard parts where one exists: RFC 9457 problem details for
  every refusal, RFC 8941 lists for `Vx-Read-Scopes`, `Content-Length`,
  `411`/`413`/`415`, no `X-` prefixes.
- Shipped: the headers vx's remotes use today, renamed:
  `x-artifact-duration` → `Vx-Duration`, `x-artifact-read-scopes` →
  `Vx-Read-Scopes`. The batch probe is `POST /v1/artifacts/query`, up
  to 1000 keys (Vercel's stops at 100).
- Shipped: a row is the commit. A PUT stores the blob, then its row; a
  blob no row names is never read. HEAD and the batch probe read only the
  database. An artifact is immutable: a second PUT is `200` and its body
  unread.
- Shipped: run history is one row per run, its tasks one JSON column; a
  task query reads the newest 100 runs with `json_each` and a window per
  task. One row per task would cost D1's free plan a row write per task
  (100 000 a day), and a query parsing runs in the Worker its 10 ms of
  CPU.

## Encryption (planned, no format change)

- The server compares strings and never reads them: keys, run ids, task
  names and bytes are opaque (PROTOCOL.md § Opaque strings). End-to-end
  encryption is then the client's alone: a workspace key the server never
  sees, an HMAC of each key and task name (equality still works, so
  lookups and history queries do), and an authenticated cipher over each
  artifact's bytes. Numbers stay plain: the server sorts and aggregates
  them for history.
- Refs in `Vx-Read-Scopes` stay plain: the server matches them against CI
  tokens, which name them.

## Access

- Shipped: static bearer tokens, listed by SHA-256 in `TOKENS` (no
  secret in the config). A write token writes the trusted scope.
- Planned: CI OIDC tokens, as the relay checks them (`jose`): a token
  matching the server's trust rules writes trusted, any other of the same
  repository writes its own branch's scope, and reads walk
  `Vx-Read-Scopes` (the ref-scope design, `cache-scope-by-ref`). Each
  repository is its own namespace (the `ns` column exists already).

## Next

- Planned: `vxCache()`, the client plugin: a remote for core's cache
  seam, and the run's history written after it and read for scheduling,
  in place of `@vzn/vx-schedule-history` where a server is deployed.
- Planned: eviction on a Cron Trigger (Workers' free plan has five) and a
  timer on Bun, by age per scope.
- Planned (with the server): flaky-task reruns and a dashboard, both read
  from the run history.
