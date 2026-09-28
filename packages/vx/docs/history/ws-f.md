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

- A: an upstream whose recorded outputs are only partly on disk still
  feeds its dependant (local executor too; vx-reapi warns "using what is
  here"), and the dependant's result is saved under a key that says the
  upstream was complete. Refuse or re-materialise in core?
- C: `cache.inputs.runtime` / `workspaceRuntime` are keyed from the
  submitter's probe but never reach a remote worker, so a Node 20 worker's
  output is saved under a Node 22 key (stale hit, vx-reapi probe P2).
  Proposal: `TaskPlacement` says whether the key folds runtime probes, and
  vx-reapi's `accepts` declines such a task (it runs here). A worker-side
  guard cannot match core's probe exactly (PATH with `.bin`, trim).

- C (resolved on main): leads 4 and 5 by item 1055 (the flush signal,
  wired into both sinks); the runtime-probe lead by C-2 (such a task is
  pinned local, and vx-reapi is never offered a pinned task).
- M/C (resolved on main by M-6): on macOS CI, `runner.test.ts` › "the
  peak is the child's own" read a heavy child's peak under its floor on two
  F PRs cut before M-6 (#1266, #1355).
- C: `TaskLogBuffer.evictToBudget()` sorts every retained entry on each
  `finish` once the 4M-char budget is full, so a run's log path is
  O(n² log n): vx-otel's sink took 0.75 s for 5 000 tasks with a 2 000-char
  tail, 8.2 s for 20 000 and 46 s for 50 000 (0.18 s at 20 000 with logs
  off), all on the run's own thread. Patch: seq is monotonic, so keep
  successes in insertion order and failures newest-last, and stub from a
  cursor instead of re-sorting (amortised O(1) per finish).
- A: on macOS CI, `task-glob-brackets.test.ts` › "an upstream's hit sets
  aside the route a dependant adds" failed once on an F PR (#1294).
- C (resolved on main by H-10): `ExecuteRequest` carries no abort signal,
  so Ctrl-C does not cancel a remote Execute (wired in F-15).

- core: `runner.test.ts` "an exec-wrapped process is the direct child" sleeps a
  fixed 50 ms before reading `/proc/<pid>/comm`; under a loaded gate
  (load 6.6) it read `JITWorker`, Bun's clone before the exec, and failed
  (2026-09-28, F-30's gate; green alone). Patch: poll `comm` until it
  leaves Bun's name, bounded at 2 s, instead of the sleep.

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

F-3. vx-reapi heals two transport losses. WaitExecution's NOT_FOUND (a
restart lost the operation) executes the action again instead of
failing the task; Execute's own NOT_FOUND still throws. A streamed
read cut after its first message re-opens at `read_offset` = bytes
read, instead of turning a remote hit into a miss. Rows red without
each fix.

F-4. vx-otel's export-failed warning printed the URL whole, leaking a
credential in userinfo or query to CI logs; now masked as `***`. Row red
without the fix. README now lists the default logs export (task output
tails, which can hold secrets) and its opt-out.

F-5. vx mcp read non-object `arguments` (a string, an array) as `{}` and
answered a filtered question for the whole workspace; now a UserError
naming the tool. Row red without the fix. README: the stdout guard
covers `console` and `process.stdout`, not writes straight to fd 1.

F-6. vx-github: a duration of 119.7 s printed `1m 60s` (seconds rounded
after flooring the minutes); now rounded once, then split. Found by a
mutation sweep of vx-github (147 mutants, 31 real survivors); rows now
hold the severe ones: GITHUB_STEP_SUMMARY activation, each Actions var
missing, POST/`vx`/head_sha, a throwing transport's warning, the trailing
newline, and CR/NUL/non-Latin-1 tokens refused unprinted.

F-7. vx-reapi's executor memoised input digests by (path, size, mtime) for
the run, so a same-size rewrite within the mtime's resolution (a restore,
`cp -p`, a fast edit) shipped the OLD blob under a key naming the new
bytes, and recorded it there. The memo saved one sha256 over bytes read
anyway; removed (`DigestCache` export with it). Row red without the fix.

F-8. vx-reapi held remote outputs to what was declared and addressed:
under a whole-tree capture (`*.txt`) a declared output missing from the
CAS only warned and `save` cached the short tree; now it fails the task.
Inline output bytes were written unchecked; now held to their digest, a
mismatch fetched. Rows red without each fix.

F-9. F-1's real-wire rows counted attempts by the RSTs the peer had sent,
appended AFTER each RST was written; a loaded gate read the count before
the last append landed (`sent: 0` for CANCEL, 3 for INTERNAL; A, B, D, H,
J saw it, 1 in 12 with 12 copies in parallel here). The peer now counts
each call's HEADERS on arrival, before its RST is scheduled: 24 of 24
under the same load.

F-10. vx mcp echoes protocol 2025-03-26, which requires JSON-RPC batches,
and refused every batch with -32600; a batch is now answered as one array
of its replies (empty stays invalid). Row red without the fix. The same PR
holds what a vx-mcp mutation sweep (146 mutants, 43 survived, no bug)
found a client would see: replies written before the next read, each
known version echoed, `id: null` vs no id.

F-11. vx-reapi: a gRPC status escaping `execute` (Execute refused, an upload
or upstream read failed) reached the scheduler as a plain Error and printed
`[vx] internal error in pkg#gen: 7 PERMISSION_DENIED…`, a vx bug by its
wording; it is now a UserError naming the task and the status. Row red
without the fix; a plain Error stays one (control).

F-12. vx-otel sent vx's task status as `cicd.pipeline.task.run.result`, an
enum in the CI/CD conventions (success, failure, error, timeout,
cancellation, skip); `failed`, `skipped`, `aborted` and the hit statuses
matched none, so a conventions-aware backend counted no failed task. Now
mapped (a timed-out failure is `timeout`), with the exact status on
`vx.task.status`. Row over every status, red without the fix. Also checked
this phase: vx mcp against the official MCP SDK client (handshake, all six
tools, errors, ping) is clean; STATUS Next 1 (a local NativeLink) is
blocked here: ghcr blobs and the GitHub API are refused by egress policy.

F-13. vx-github told every failed-with-403 check-run POST to check
`permissions: checks: write`, but GitHub answers a rate limit with 403 as
often as 429; a rate-limited run now says so (not retried: retry-after
outlasts the flush deadline). Row red without the fix; a plain 403 keeps
the permission hint.

Measured, no cut: REAPI upload sequencing. Through a proxy adding 15 ms
one-way, 400 x 64 KiB (7 batches) took 12.9 s and 10 x 5 MiB 25.5 s,
about 2 MB/s: HTTP/2 flow control on one connection, which parallel
streams share. Sequential calls cost at most one RTT each (17 calls,
~0.5 s of 25), so a pool is not worth its complexity.

F-14. vx-reapi took any endpoint string: `http://` failed the run with
grpc's `Could not parse target name ""`, and a blank value or
`host:notaport` degraded every request to a miss with a grpc message. The
endpoint is now checked once (a blank one declines like an unset one; a
malformed one is a UserError naming `reapi({ endpoint })` or
`VX_REAPI_ENDPOINT`); grpc resolver targets (`unix:`, `dns:`) pass
through. Rows red without the fix. Refuted this round: vx-github's
"0 failed" check title needs a run red with nothing failed or aborted,
which only an all-group abort produces.

F-15. vx-reapi heard nothing of the run stopping: on Ctrl-C vx waited on the
remote Execute as long as the action ran (forever on a stalled server).
H-10's `ExecuteRequest.signal` now cancels the operation stream, and an
action the stop precedes is not submitted. Row red without the fix.

F-16. vx-otel's `vx.run` span was always status UNSET with no
`cicd.pipeline.result`, so a red run read as a clean one to a backend; it
now carries the result (a run stopped with nothing failed is
`cancellation`) and ERROR when red. Row red without the fix. From a
mutation sweep of `otlp.ts` and `plugin.ts` (238 mutants, 34 survived):
rows now hold header `=` padding, `OTEL_SDK_DISABLED` case, and per-signal
header and option-over-env precedence. Not taken: `OTEL_EXPORTER_OTLP_PROTOCOL`,
`_TIMEOUT` and `OTEL_RESOURCE_ATTRIBUTES` are not read (JSON only).

F-17. vx-otel ignored three standard OTLP env vars a pipeline sets for
every exporter: `OTEL_RESOURCE_ATTRIBUTES` (deployment, team) never
reached the resource, `OTEL_EXPORTER_OTLP_TIMEOUT` was not the timeout,
and under `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` an export to the gRPC port
failed with a transport error naming neither. The first two are read; the
third's failure now says vx sends OTLP/HTTP only. Rows red without each.

F-18. vx-reapi restored an output directory with one BatchReadBlobs per
directory, in sequence: a `dist/` of 200 one-file directories took 6.8 s
through a proxy adding 15 ms each way. Files are now gathered across the
tree and fetched in 64 MiB windows: 0.32 s (min of 5, interleaved A/B
against main; 885 → 256 ms with no added latency). Row counts one call
for 40 directories, red (40) without the fix.

F-19. vx-reapi sent every input digest in one FindMissingBlobs: an input
tree of 70 000 files (a `node_modules`) is a 4.9 MB request, past a
server's 4 MiB default receive limit, and the task failed
RESOURCE_EXHAUSTED on every attempt. The list is now split by encoded
size, the requests sent together. Row red without the fix.

F-21. vx-reapi's cache layer threw when the hit's DURATION (metadata a
server may move into CAS) could not be read, and core dropped the valid
hit as a miss; the duration is now unknown instead. Row red without the
fix (`15 DATA_LOSS`). From a mutation sweep of `cache.ts` (50 mutants, 44
caught, no other bug): rows now hold its five real survivors (a non-JSON
or evicted duration is unknown, not 0; an entry at another path is no
hit; put records exit 0; the duration is read before the artifact), each
driven red.

F-22. vx-otel sent a run's spans in one request, and its logs in another:
20 000 tasks made a 23 MiB trace, and otelcol 0.161 refused it whole
(`request body too large`, its 20 MiB default); logs ran 16 MiB at the
same size. Both now go at most 1 000 items to a request, sent together;
a failure warns once per signal with how many requests failed. 20 000 and
50 000 tasks export clean against the same collector. Rows red without
the fix.

F-23. F-22's batches bounded a request's ITEMS, not its bytes, and a log
tail is bounded in characters: JSON writes a control character as six
bytes, so 64 failed tasks printing control bytes made one 23 MiB logs
request, refused whole. A body past 4 MiB is now split in half until it
fits (probe: 9 requests of at most 3 MiB). From a mutation sweep of
`sink.ts` (114 mutants, 30 real survivors): rows now hold id lengths, a
started-less task's span id, a task span's start, status and run
attributes as shipped, the exact `wants`, and the part-failed, throwing
and unparsable-URL warnings. Rows red without each.

F-20. vx-reapi's default ByteStream chunk was 128 KB, which the README said
wedges "once in hundreds of runs". Measured on Bun 1.4.2 against
bazel-remote, a 1 MiB write in a fresh process stalled to its 30 s deadline
in 2 of 12 runs (the cache.ts sweep saw up to 10 of 15), before the
downgrade retried it; at 65535 none of 12 stalled. The default is now
65535: +45% on a 32 MiB upload (390 → 590 ms, loopback), far below one
expected stall. 128 KB stays an opt-in with the downgrade as its net. The
same sweep (50 mutants, 44 caught, 5 real survivors) found no bug in
`cache.ts`; its rows landed in F-21. Also checked this round: vx-reapi's
live suite against Buildbarn bb-storage passes 16 of 17 (the one miss is
QueryWriteStatus, UNIMPLEMENTED there, which an upload's resume already
treats as "start over"); reading 20 × 5 MiB outputs in parallel instead of
in turn measured no gain on loopback (~1.1 s either way), no cut.

F-24. vx-reapi's remote hit read the duration (which bazel-remote moves
into CAS) and only then opened the artifact: one round trip more per hit.
Both now start together: 130 → 98 ms per hit through a proxy adding 15 ms
each way (min of 15, interleaved A/B against main). Live suite against
bazel-remote 17 of 17. F-21's order row now requires the overlap; red
without the fix.

F-25. vx-reapi's GetActionResult on a hit asked for nothing inline, so a
hit always spent a ByteStream Read on its artifact (and, on bazel-remote,
another on its duration). It now asks for stdout and the artifact inline;
bazel-remote honours both up to ~1 MiB (a 5 MiB artifact still streams)
and the spec lets any server decline. Inline bytes are held to their
digest; a mismatch streams. A 64 KiB hit: 132 ms on main, 99 with F-24,
66 now (15 ms each way, min of 15, interleaved). A replayed execution
record's read asks for its stdout inline too. Live suite 17 of 17. Rows
red without the fix.

F-26. vx-reapi's cache save probed FindMissingBlobs before every upload,
a round trip of its own that could skip at most a small artifact's bytes.
An artifact up to 256 KiB is now sent in one BatchUpdateBlobs unprobed
(a refused batch streams); larger ones keep the probe. A 64 KiB save:
102 → 69 ms through a proxy adding 15 ms each way (min of 15,
interleaved). Live suite 17 of 17. Row red without the fix.

F-27. vx-reapi wrote a remote execution's record (a stdout blob probed and
uploaded, output Trees read, then UpdateActionResult) before restoring a
single output byte. The record is now written while the outputs come
down, and stdout up to 64 KiB rides it inline (`stdout_raw`, which the
replay already reads). Execute plus restore of a 20-directory tree with a
record: 295 → 234 ms through a proxy adding 15 ms each way (min of 5,
interleaved). A restore failure still waits for the record. Rows red
without the fix.

F-28. vx-otel dropped an export whole on a collector's first 429 or 503,
the answers the OTLP spec names as "retry later". The transport now
retries 429, 502, 503, 504 and a failed connection twice (200 and 800 ms,
or the Retry-After it names, at most 2 s), inside core's flush deadline;
other refusals (400, 401, 500) still fail at once. Rows against a real
HTTP server, red without the fix.

F-29. vx-github's check-run POST gave up on GitHub's first 502, 503 or 504
or a dropped connection, and the run had no check. Those are now retried
twice (200 and 800 ms) inside the flush deadline; a retry after a 502
GitHub did process adds a same-name run, which GitHub shows as one. Rate
limits (F-13) and refusals still warn at once. Row red without the fix.

F-30. vx-reapi read each remote-only upstream's execution record, probed
its blobs and read its trees one upstream after another, so a task with
N such upstreams waited N times the round trips. All upstreams, and each
one's trees, are now read at once: 8 upstreams 681 → 234 ms through a
proxy adding 15 ms each way (min of 7, interleaved A/B). Row red without
the fix. Refuted on the way: vx-mcp's getRunHistory ranks pairs with
`SELECT DISTINCT … ORDER BY started_at`, which SQL leaves undefined, but
on the real schema every filter keeps the `started_at` index scan, so
the newest run is met first and the ranking holds (a bare table with a
`task` filter did drop the latest task).

F-31. vx-reapi's execution record splits a `dir/*` output into one Tree
per match, and uploaded each with a probe and a Write of its own, one
after another. They now go up through one probe and batches (a Tree
past the batch limit still streams); a failed probe or batch writes each
as before. 100 packages: 7.1 → 0.44 s cold, 3.4 → 0.26 s warm, through
a proxy adding 15 ms each way (min of 7, interleaved). Row red without
the fix.

F-32. vx-reapi's client offered HTTP/2's default 64 KiB receive window,
so a read moved one window per round trip: 2 MB/s at a 30 ms round
trip, whatever the link. It now offers 16 MiB per stream and per
connection. Two 4 MB reads through a proxy adding 15 ms each way:
3982 → 116 ms against bazel-remote, 3988 → 142 against the fake (min of
5, interleaved). Uploads are bound by the server's window, not ours.
Live suite 17 of 17. Row red without the fix.

F-34. vx-reapi's `uploadBlobs` (remote-execution inputs, split record
Trees) sent its batches and streamed writes one after another. A grpc-go
server grows its receive window from what it measures arriving, and one
stream at a time kept it small: each 1 MiB of a write waited 130–850 ms
for the window. Up to 8 now run at once and the first failure stops the
queue. Against bazel-remote through a proxy adding 15 ms each way: four
8 MB blobs 10.15 → 0.53 s, 400 of 64 KiB 1147 → 685 ms (min of 5,
interleaved). Live suite 17 of 17. Row red without the fix.

F-33. vx-otel ignored `OTEL_EXPORTER_OTLP_COMPRESSION`, so a pipeline
set for gzip sent every export as raw JSON. It and each signal's own
`OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION` are now read (the
`compression` option tops both); `gzip` sends the body gzipped with
`content-encoding: gzip`, compressed once, not per retry; any other
value warns and sends uncompressed. A 1 000-task trace: 971 KB → 33 KB
for 4 ms of gzip. A live collector (0.161.0) took the gzipped export.
Rows red without the fix.

F-35. vx-reapi read an execution's stdout and stderr before its outputs
started coming down, so a server that keeps stdout in CAS (Buildbarn)
cost every remote execution a Read in series; and a stdout over 64 KiB
was hashed and probed again to be recorded, though the server already
held it. The outputs now start first and the record names the server's
own stdout digest. Execute to restored through a proxy adding 15 ms
each way, 100 KB stdout in CAS: 256 → 220 ms (min of 7, interleaved).
Rows red without the fix; the record's failed-Tree-read row now runs
remote-only, since the download's read of that Tree comes first.

F-36. vx-reapi's input tree for a remote execution read its files one at
a time (lstat, then read, per file), so 2 000 small inputs cost 304 ms
of file-system round trips on every execution. Up to 32 now read at
once and go into the tree in the same sorted order: 301 → 51 ms (min of
7, interleaved). The first failure stops the reads. Row red without the
fix; two unused imports in the files went with it.

F-37. vx-reapi restored remote outputs one file at a time: fence,
mkdir, fetch when not batched, write, chmod, each awaited before the
next file began. Up to 32 files now go at once, for loose output files
and for a Tree's files alike; directories are still fenced and made
before any file is written into them. 2 000 small output files, no
latency: 1 167 → 254 ms; a 2 000-directory Tree: 2 146 → 1 519 ms (min
of 5, interleaved). Rows red without the fix.

F-38. vx-github's job summary found the tasks each failure blocked by
scanning every task once per failure, so a mass failure rendered in
quadratic time: 10 000 failures of 20 000 tasks took 1.3 s of the
flush's bounded time. Blocked tasks are now grouped by their blocker in
one pass: 1 310 → 35 ms, output byte-identical (a mixed 3 000-task
summary compared against main's). Row red without the fix.
