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

- C: `orchestrator/run-report.ts`'s table-cell escape replaces `\r?\n`
  only, so a lone CR (a CommonMark line ending) in a task id ends a
  markdown table row early, vx-github's rows included; `/\r\n?|\n/`
  covers it (F-51 review).

- C: `vx mcp` resolves the cache directory once, at server start
  (`ctx.cacheDir`), so a `cacheDir` changed in vx.workspace.ts while it
  serves leaves the cache tools and `getWorkspaceInfo` on the old one,
  while `listTasks` re-resolves it per call. `resolveCacheDir` is not on
  `@vzn/vx`; a command context that resolves it per call, or the export,
  lets the tools follow.
- C: `vx why --run` and `vx last` take a run-id prefix (`resolveRunId`,
  cli/run-id.ts), as `vx last --list` prints it, but `@vzn/vx` does not
  export it, so vx-mcp's `whyDidThisRerun` answers `found: false` for a
  prefix `vx why` resolves. Exporting it lets the tool take the same ids.
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

F-39. vx-otel did not read the OTLP spec's TLS files, so a collector
behind a private CA failed every export on its certificate, and one
that asks for a client certificate refused the connection.
`OTEL_EXPORTER_OTLP_CERTIFICATE`, `_CLIENT_CERTIFICATE` and
`_CLIENT_KEY` (and each signal's own) are now read once per run and
handed to fetch; a file that cannot be read warns once and is not used.
Rows against a real TLS server, certificates made per run by openssl
(no key checked in), red without the fix.

F-40. vx-otel and vx-github retried a fetch that failed on the server's
certificate as if the connection had dropped: an untrusted, expired or
misnamed certificate fails the same way each time, and the two retries
spent a second of the flush deadline before the same warning. A code
naming a certificate (or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) is now
thrown at once; a reset connection is still retried. The warning names
the fix: `OTEL_EXPORTER_OTLP_CERTIFICATE` for vx-otel,
`NODE_EXTRA_CA_CERTS` for a GHES host behind a private CA (Bun's fetch
trusts it; probed). Rows red without the fix, the reset control holds
both ways.

F-41. vx-reapi reached a TLS server with the system roots and no client
certificate, so a server behind a private CA, or one that asks for
mutual TLS (EngFlow, a self-hosted Buildbarn), was unreachable. The
plugin now takes `tlsCertificate`, `tlsClientCertificate` and
`tlsClientKey` (or `VX_REAPI_TLS_*`), PEM files read at startup, as
Bazel's `--tls_*` flags; any of them turns TLS on, and an unreadable
file is refused naming its setting, as is a client certificate
without its key or the reverse. Rows against the fake server over
TLS and mutual TLS, certificates made per run by openssl; red without
the fix. The README pin now holds the three variables.

F-42. vx-github clamped its job summary to 1 MiB on its own, but GitHub's
cap is the step's whole summary file: a page appended after another
tool's 900 KB made 1.9 MB and GitHub refused both. The page now fits in
what the file has left, and with no room it is skipped with a warning.
Row red without the fix (the file reached 1 948 576 bytes). Tests that
inject `append` no longer read a real `/tmp` path's size (a new `sizeOf`
seam; a 1 MB `/tmp/sumfile.md` left by an earlier run turned them red).

F-43. vx-reapi encoded and decoded protobuf varints with 32-bit bit
operators, so a size of 4 GiB or more went modulo 2^32: a 5 GiB input
file's Digest named 1 GiB (an input root the server holds under other
bytes), and a 5 GiB output decoded short. Sizes are now exact to 2^53
(arithmetic, not bit operators); a ten-byte varint past that (a
negative int32, the exit code) still reads back as its low 32 bits.
Rows against protobufjs and round trips, red without the fix; the
negative exit code row holds both ways.

F-45. vx-otel declined whenever no traces endpoint was set, so a
pipeline that set only `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (or the
logs one) exported nothing and said nothing, though each signal ships
only to its own url. The plugin now declines only when no signal has an
endpoint; one without its own stays off. Row red without the fix.

F-44. vx-reapi read a compressed ByteStream write the server answered
with `committed_size: -1` as a short write and failed the upload. The
spec says a server that already holds the blob (or sees another client
upload it at once) ends a compressed write early with exactly that, and
the client should not retry: two actions sharing an input could fail
each other. `-1` on a compressed write is now done. The fake server can
answer it; row red without the fix.

F-46. vx-otel and vx-github retried past core's flush deadline: a
deadline that passed during the wait after a 503 or 502 let the loop
POST again (vx-github's `Bun.sleep` also ran its full 200 or 800 ms),
and the warning named the AbortError, not the collector's or GitHub's
answer. The wait now ends at the deadline and the last answer is
warned. Rows red without each fix. Refuted again on the way:
getRunHistory's DISTINCT order, on the real schema, with a task filter
and 50 older runs (a three-column table drops the latest; the real one
scans `runs_started_at` newest-first for every filter).

F-47. vx-reapi judged a server's symlink target as text, but the OS
follows the links the result already placed: with `x -> ..`, a link
`y -> x/../../outside` read as inside the project and led out of the
workspace (output symlinks and Tree SymlinkNodes, either order). Once
all are placed, each link is now resolved component by component as
the OS follows it, and one that leaves is removed and refused. Bun's
`realpath` collapses `..` as text before following a link (probed:
ENOENT where coreutils answers the outside directory), so it could
not judge this. Row red without the fix, both orders and the Tree.

F-48. vx-reapi dropped two parts of an Execute answer. A v2.0 server
names its output links only in the deprecated `output_file_symlinks`
(10) and `output_directory_symlinks` (11), which the decoder skipped, so
the link was never restored or recorded; they are now read when
`output_symlinks` (12) is absent (a v2.1 server fills both). And a
failed status that carries a partial result (DEADLINE_EXCEEDED from a
worker's timeout) threw without the command's stdout and stderr; they
are now delivered first. Rows red without each fix (the decoder's
against protobufjs).

F-49. vx-otel read four pieces of the OTLP env wrong. A base
`OTEL_EXPORTER_OTLP_ENDPOINT` with a query (`https://c/otlp?tenant=a`)
had `/v1/traces` glued onto the query's last value; it is now appended
to the path. `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` was not read; it
now wins for its signal, the option over both. A malformed
`OTEL_RESOURCE_ATTRIBUTES` (a bad escape, a pair without `=`) was sent
in part; the Resource SDK spec drops it whole, and it warns. And with
traces off, each log record still named a trace and span never
exported; they are left off. Rows red without each fix.

F-50. vx-reapi's cache save hashed a small artifact on one read of its
file and sent it from a second. A second writer of the key (another
workspace on one `--cache-dir`) renames its artifact over the file, so
the upload could carry B under A's digest: refused by a verifying
server (the save lost), stored by one that does not (a hit that then
fails its digest and reads as a miss). A small artifact is now read
once and those bytes hashed and sent. A large one keeps its two
streamed passes. Row red without the fix. The cache path's review
found no wrong-bytes hit (upload before the AC entry, streamed and
inline hits held to size and digest, namespaced keys).

F-51. vx-github's summary broke in three places. A step writer that
left no final newline (`printf 'coverage 91%'`) ran vx's heading into
its paragraph; after another writer the page now starts on its own
line. A duration picked its tier before rounding, so 59.96 s printed
`60.0s` and 999.6 ms `1000ms` (a sweep row had pinned `60.0s` for
59 999 ms; corrected in place). And the footer's code span kept a lone
CR, a CommonMark line ending. Rows red without each fix.

F-52. vx-mcp's tools answered three questions wrong. `getRunHistory`'s
empty answer dropped the `limit` the README says every answer carries
(lead 10; two rows had pinned the gap, corrected in place). A
`project#task` passed as its `task` filter could never match (a task
name holds no `#`) and answered an empty success; it is refused, naming
the two filters to pass. And `whyDidThisRerun` on a task whose runs
predate run ids said it had no recorded runs; it answers the latest
cache entry, as `vx why` does. Rows red without each fix.

F-53. A mutation sweep of vx-otel's `sink.ts` (145 mutants: 108 caught,
19 real survivors, 17 equivalent, 1 lint artifact) found no bug and
these unheld: a `partialSuccess` rejecting data points or log records,
or with counts and no message, passed silently; `partialSuccess: null`
warned; gzip reached a signal not asked for it; a Retry-After past 2 s
was waited whole; 502 and 504 retried, 500 not; a POST's own timeout
not retried (F-49's row had a bound three timeouts wide); and the 4 MiB
request limit counted in bytes (an ASCII fixture passed a count of
characters). Each row now fails with its mutant (12 driven). Left:
cosmetic trims, the deadline's sleep-then-throw path, the logs'
`vx.workspace.id` wiring (the builder's own row holds it).
Also: F-36's concurrency row slept 5 ms per read and read a peak of 4
in one gate under load (the first read ended before the fifth began);
each read now holds until all five have started, released after 200 ms
for a serial reader, which fails on the peak (1).

F-54. A mutation sweep of vx-mcp's `tools.ts` (156 mutants: 133 caught,
5 of them by the type-check; 6 equivalent; 17 real survivors) found no
bug and these unheld: a recent run row's `runId` (the id an agent hands
`whyDidThisRerun`), `cacheHit`, `endedAt` and `durationMs`;
`getCacheStats`' hit count apart from its run count; `history` held to
`limit`; `explainCacheKey`'s exit code and creation time;
`getWorkspaceInfo` reading the context's cache dir; the task filter's
refusal naming `task`, and its `project#task` hint splitting at the first
`#`. Rows now hold each (11 re-driven). Left: a handler's `cache.close()`
and the warn callbacks (a descriptor count and a stderr capture each).
Checked on the way: F-52's refusal of `#` in a task filter stands, since
config loading refuses `#` in a task name (item 1000); core's
`splitTaskId` comment calling such a name legal is stale.

F-55. A mutation sweep of vx-github's `summary.ts` and `plugin.ts` (206
mutants: 151 caught, 18 equivalent, 2 no-op controls, 19 real survivors
in 16 behaviours) found no bug and these unheld: failures beside aborts
headed as a failed run (not cancelled) and aborts kept out of Failures;
a failure with 0 violations saying nothing, 1 singular; one table row
per task, failures first; 90 s as `1m 30s`; every inline escape class
in an id (`\`, backtick, `_`, `[`/`]`, `<`/`>`; `<!--` hides the rest
of a page) in the table, a failure and a blocked id; a code span around
a backtick run or one at either end; the `summaryFile` option over
`GITHUB_STEP_SUMMARY`; the lead newline after a one-byte file. Rows now
hold each (23 re-driven). Left: literal cap and suffix text, blank-line
placement, the Latin-1 header boundary, the constructor's dead `sizeOf`
default.

F-56. vx-otel armed each request's timer with the configured timeout as
given, and a timer past 2^31-1 ms fires after 1 ms: an
`OTEL_EXPORTER_OTLP_TIMEOUT` of `1e10` aborted every export at once. It
is now held to 2^31-1 ms. Found by a mutation sweep of `plugin.ts` (226
mutants: 157 caught, 69 survived), whose real survivors now have rows
(23 re-driven): `otel()` reading `process.env` and warning through its
context; metrics and logs headers no request can carry dropped; a
header value's CR, NUL and past-Latin-1 refusals, `é` and a trailing
newline kept, a line break reported before a wide character;
`OTEL_TRACES_EXPORTER=otlp` keeping traces on; `OTEL_RESOURCE_ATTRIBUTES`
decoded and trimmed keys, a value holding `=`, the last duplicate
winning, a trailing comma, an empty key refused; an empty endpoint
option falling back. Left: precedence rows (headers, compression,
per-signal timeouts), gRPC/compression trims, header-name token edges,
the non-URL `joinSignal` fallback.

F-57. A mutation sweep of vx-reapi's code changed since its sweeps
(F-32..F-50: cache.ts put and hit, the TLS options, wire.ts writes and
the upload pool, executor.ts's link fence, legacy links and partial
output, the varints; 151 mutants) found no bug and these unheld, now
rows (29 re-driven): the fence against an absolute-target chain, a
sibling sharing the root as a prefix (`ws-evil`), three- and four-link
chains, and as controls a link to the root and a root reached through
a link; the plugin's TLS options reaching the connection (CA and client
pair against a mutual-TLS server, a CA alone meaning TLS), an option
over its env var, a trimmed and an empty env path, a key alone refused,
an unreadable client certificate named; every blob of several batches
stored, and a refused write rejecting the upload and stopping the
queue; a write committed short, `-1` uncompressed, or `0` compressed
refused; a failed status whose partial log fails its read still
refusing with the execution's failure. A suspected fence escape
(a directory written through a chain link) was probed and refused
(`fence.dir`). Left: exact batch-budget boundaries, the receive limit
on the other stubs, `tls: false` beside a CA, and equivalents (varint
paths past 2^53 the decoders never meet, `path.join`'s own `..`).

F-58. A mutation sweep of vx-github's `checks.ts` (150 mutants: 108
caught, 12 equivalent, 30 real survivors) found no bug and these
unheld, now rows (23 re-driven): the POST reaching a GHES `apiUrl`;
502 and 504 retried, 500, 429 and 403 not; three blips tried three
times 200 then 800 ms apart; every `CERT` refusal tried once with the
NODE_EXTRA_CA_CERTS hint; a drop then the deadline during the wait
warning once, at once; a page under 65535 units but over 65535 bytes
clamped, an ASCII one to exactly 65535 bytes; a 40-hex sha kept whole;
one aborted task with nothing failed titled cancelled. Left: the
abort-guard pair (equivalent: `sleepUnless` answers an aborted signal
at once), the retry timer's clearTimeout, the suffix's text, a thrown
non-Error's text.

- **F-60** vx-mcp: `whyDidThisRerun` takes a run id by the unique prefix `vx last --list` prints; `resolveRunId` moved to `orchestrator/run-id.ts` and is on `@vzn/vx`. `docs/modules/metrics.md` held committed merge markers; `conflict-markers.test.ts` refuses them. Breaking by the contract law: the packed `src/cli/run-id.ts` moved and the `runId` description changed.
- **F-59** vx-reapi: a server that stays down pays the 2.1 s retry backoff once; the cache path fails fast on UNAVAILABLE until the server answers (J-74: a refused port, five tasks, 24 s → 2.6 s wall). Row: `wedged.test.ts` › "a server that stays unreachable".
- **F-61** The `executor` plugin example (`vx init --plugin executor`) spawned `['sh', '-c', …]` with `req.env`, whose PATH leads with the project's `node_modules/.bin`, so a dependency's `sh` ran every command (L-33's class). It takes `Bun.which('sh')` (vx's PATH) now; core's template copy regenerated. Row: `vx-plugin-examples/plugins/executor.test.ts` › "runs the command through this machine's sh", a planted `sh`; red without the fix.
- **F-62** J's lead: `vx completions` offers `--help` for every plugin verb, and core leaves a plugin verb its own help, but `vx mcp --help` and `vx history --help` (vx-schedule-history) exited 1 as unknown flags. Both print their usage and exit 0 on `--help` / `-h`. Rows: `vx-mcp/tests/server.test.ts` › answers --help and -h (an unknown flag still refuses), `schedule-history-e2e.test.ts`'s verb row; red without the change.
- **F-63** vx-mcp: a misspelt tool argument (`getRunHistory({ tsk })`) was ignored and the unfiltered history answered as the filtered one. A key outside the tool's `inputSchema` is refused, naming the keys it takes (#2439). Row: `vx-mcp/tests/unknown-arguments.test.ts`; red without the fix.
- **F-64** vx-mcp: `getCacheStats({ scope: { project, task } })` ignored `task` and returned the project's numbers as the task's; the scope takes `project` alone (#2449). Row: `cache-scope-keys.test.ts`; red without the fix.
- **F-65** Bun strips a config's types, so a misspelt factory option (`reapi({ endpont })`) reached the plugin as unset and the run went local with no word. Core exports `refuseUnknownOptions`; all 11 first-party factories call it with a key list held to their options interface by the type checker (TS2741 / TS2353 both ways) (#2446). Rows: core `plugin-unknown-options.test.ts`, one `unknown-options.test.ts` per plugin package; red without the call.
- **F-66** A plugin timeout option of 0, a negative or a non-number aborted every request as it started (`otel({ timeoutMs: 0 })`, nxCache, reapi's call/meta/execute deadlines) or made `AbortSignal.timeout` throw (turboCache). Each is refused naming the option; turboCache keeps 0 as no deadline, as Turbo reads it (#2456). Rows: `vx-otel/tests/timeout-option.test.ts`, `vx-migrate/tests/cache-timeout-options.test.ts`, `vx-reapi/tests/timeout-options.test.ts`; red without the fix.
- **F-67** vx-otel: a `headers` option value that is not a string (`{ 'x-tenant': 42 }`) threw `value.trim is not a function` out of the plugin. It is dropped with the warning a value fetch cannot send gets, and the other headers go (#2459). Row: `vx-otel/tests/header-option-type.test.ts`; red without the fix.
