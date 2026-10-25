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
- Shipped: CI OIDC tokens, checked with `jose` as the relay does: a token
  matching a `TRUST` rule writes trusted, any other of the same repository
  its own branch's scope, another repository nothing. A branch a rule
  trusts is never an untrusted write's scope, since a read naming it
  walks it before trusted. A rule's `ns` keeps repositories apart.
  `vxCache({ oidc: true })` sends GitHub's token; GitLab's `id_tokens`
  is `VX_CACHE_TOKEN`.

## Next

- Shipped: `vxCache()` (`@vzn/vx-cache`), the client plugin: a remote for
  core's cache seam, every read naming the run's refs in
  `Vx-Read-Scopes`. Tested against the real server, in process.
- Shipped: `vxCache()` writes a CI run's task timings after it (a hit
  records its producing run's duration) and orders every run by the
  critical path the server's timings give, through `ctx.refine`, so no run
  waits on the server. The score is `@vzn/vx-schedule-history`'s `criticalPath`.
- Shipped: eviction by age since the write, per scope (trusted 30 days,
  a branch 7, runs 90), on a daily Cron Trigger (Workers' free plan has
  five) and an hourly timer on Bun. Not by last read: that would cost a
  D1 row write per hit.
- Planned (with the server): flaky-task reruns and a dashboard, both read
  from the run history.
