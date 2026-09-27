# Workstream F — remote and telemetry plugins (vx-reapi, vx-otel, vx-github, vx-mcp)

## Leads (review of 2026-09-27)

Ranked by harm. Each becomes one PR, numbered F-n when it merges.

1. vx-reapi: INTERNAL is not retried. grpc-js spells a call cut in transit
   (RST_STREAM(INTERNAL_ERROR) from a proxy, a stream ended with no status)
   as INTERNAL, so one such cut failed a unary call and a Read at once and
   failed a remote task whose Execute stream it cut, although the operation
   lived on. Bazel's executor classifier retries it. → F-1.
2. vx-mcp: the read-only tools (`getCacheStats`, `getRunHistory`,
   `getTaskHistory`, `getRunDetail`) open the cache in `open` mode: on a
   workspace that never ran they create `.vx/cache/`; on an index from an
   older schema they reset it silently, dropping the run history; `close()`
   prunes old rows. The README says nothing there writes the cache.
3. vx-reapi: `WaitExecution` answering NOT_FOUND (a server that lost its
   operations on a restart) fails the task. The operation is gone, so the
   action can be executed again; Bazel re-Executes.
4. vx-github: the Checks API POST has no deadline of its own. Core's flush
   deadline bounds `run()`, not the process: a hung API keeps vx alive past
   the run. README and `checks.ts` claim the flush deadline bounds it.
5. vx-otel: an export's own `timeoutMs` (15 s) outlives core's 3 s flush
   deadline, so a hanging collector holds the process 15 s; the README says
   core's end-of-run deadline cuts it off.
6. vx-mcp: `getRunHistory`'s `history` is `SELECT DISTINCT … ORDER BY
started_at DESC LIMIT n`, which orders each task by an arbitrary run:
   the task that ran last can be missing from it.
7. vx-reapi: `readBlobStream` errors the restore on a transient status past
   its first message; ByteStream `Read` takes a `read_offset`, so the read
   can resume where the reader is.
8. vx-otel: an endpoint URL carrying a credential (userinfo, a query key) is
   printed whole in the export-failed warning.
9. vx-otel README: the default logs export (each executed task's output
   tail) is not listed under what it exports.
10. vx-mcp: `getRunHistory` on an empty answer omits the `limit` the README
    says every answer carries.
11. vx-mcp: `arguments` of the wrong shape (a string, an array) is coerced
    to `{}` rather than refused, against the file's own header.
12. vx-mcp: the stdout guard covers `console` and `process.stdout.write`
    only; a config's `fs.writeSync(1, …)` or an inherited child reaches the
    protocol stream. The README claims more.
13. vx-mcp: an unknown tool is an `isError` result where MCP names -32602;
    the server echoes protocol 2025-03-26, which requires batches, and
    refuses them.
14. vx-otel, vx-github: stale comments naming a "cloud sink" that does not
    exist; a run stopped with nothing failed or aborted is titled
    "0 failed" (needs a probe that core can produce it).
15. vx-reapi: `getTree` has no retry; vx-mcp: the server serves on into a
    closed stdout until stdin closes.

## Leads for other streams

- C: core's telemetry flush deadline (`settleWithin`) bounds `run()` but
  passes the sink no signal, so a sink cannot stop its own work when the
  deadline passes; the pending export keeps the process alive.
- C: `loadResolvedProjects` (orchestrator/projects.ts) opens the cache
  writable, so `vx mcp`'s `listTasks` can reset an older-schema index.

## Merged

F-1. vx-reapi retries INTERNAL as it retries UNAVAILABLE. Probe, Bun 1.4.2,
a peer that answers each call with RST_STREAM(INTERNAL_ERROR): grpc-js
reported `13 INTERNAL: Received RST_STREAM with code 2 (Internal server
     error)` after ONE attempt; with the fix, four. Rows: the real-wire pair
in `wedged.test.ts` (INTERNAL retried, CANCEL's count of one as the
control), a unary call and a Read against the fake (DATA_LOSS still
fails at once), and an Execute stream cut with INTERNAL re-attaching by
name; each red without the fix. Four existing rows that used INTERNAL
as their non-transient failure moved to DATA_LOSS or PERMISSION_DENIED.

F-2. vx-mcp's four cache tools open the index with `Cache.inspect`, as the
reading verbs do. Opened as a run opens it, a call created `.vx/cache/`
where there was none (a row pinned that as a FINDING and passed), reset
an earlier schema's index with its run history and said nothing, and
pruned month-old runs on close. Rows: no `.vx` made by any of the four
(a seeded cache as the control); month-old history survives a read, and
an earlier schema is refused by each tool as a UserError and left as it
was; both red without the fix. README says what a read leaves alone.
Lead 6 (`getRunHistory`'s DISTINCT order) is REFUTED on the real
schema: `runs_started_at` makes SQLite scan newest-first and keep each
pair's first, which is its latest; the five-run repro that drops `a`
on a bare table returns `[a, c]` there, filtered or not.
