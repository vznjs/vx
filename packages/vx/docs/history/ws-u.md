# Workstream U — what a run looks like in a telemetry backend (2026-10-06)

The owner, viewing vx-otel's export in otel-desktop-viewer: metrics held
only run counts, where per-task CPU and memory over time were expected;
and traces should use span events, links and more objects.

- **U-1.** 2026-10-06 (owner chose live sampling) — per-task metrics. At
  each task's end vx-otel sends `vx.task.duration`, `vx.task.cpu_time`
  and `vx.task.peak_memory` gauges keyed by task (a skipped task sends
  none). While a task runs, core samples its process tree each second
  (`sampleTrees`, by parent pid so a sandboxed tree counts) as the opt-in
  `task.sample` record, and vx-otel sends `vx.task.cpu_usage` (cores) and
  `vx.task.memory` (bytes). The pid reaches the sampler through
  `ExecuteRequest.onSpawn`; no sink wanting `task.sample` means no timer
  and no read. The run's metrics ride the first metrics request beside
  the first batch of task points. Rows: `proc-sample.unsafe.test.ts`,
  `vx-otel/tests/otel.test.ts` › "charts each task".
- **U-2.** 2026-10-06 (owner: "use Events, Links and other objects") —
  traces show the graph and the run's stages. A task span links to the
  spans of the tasks it waited on (`task.start`'s new `dependsOn`, a
  group seen through) and carries `vx.task.retry` events (the new
  `TaskTelemetry.failedAttempts`) and a `vx.task.timeout` event. The
  run summary's new `stages` are `VX_TIMING`'s marks, now kept whether
  or not the table prints (`stageTimes`; `beginRun` restarts them for an
  embedder's later run), drawn as child spans of `vx.run`: the 23 ms
  before the first task of an all-cached run reads as `classify + probe`.
  Rows: `telemetry-trace-facts.test.ts`, `retries.test.ts`,
  `vx-otel/tests/otel.test.ts` › "links a task".

- U-3 — OTel gives everything vx knows, linked, and can send it live.
  Each task span adds its command, its flaky record, on a hit what the
  stored run took (`vx.cache.stored_*`, and `vx.task.time_saved` /
  `vx.run.time_saved_ms`), the `admit` wait, and a `vx.sandbox.violation`
  event per denial (core's `TaskTelemetry` gained the six fields). Every
  signal's resource names the run (`service.instance.id`), host and
  commit; each task metric point carries its span as an exemplar; a log
  record is timed at its task's end. `otel({ live: true })` sends each
  task as it ends, plus `vx.run.start` / `vx.task.start` log records,
  one send in flight at a time; 60 tasks against a local collector ran
  1,108 ms live against 1,101 ms (min of 6). And `otel()` imports its
  exporter only once an endpoint is set (`crypto.getRandomValues` over
  `node:crypto`): the plugin's import after core went from 9.6 ms to
  1.4 ms. Rows: `vx-otel/tests/otel.test.ts` › "live mode", "signals
  link to each other", "loads the exporter only when one is configured";
  `telemetry.test.ts` › "task.end carries what a hit saved".

- U-4 — OTel sends live by default and names the repository. Live sends
  batch for 1 s, one in flight: 60 tasks burn the same CPU live as at
  the end (median of 10: 815 ms both), so `live` defaults to `true`. A
  task's end only queues; sends in flight are cut at the teardown
  deadline, so a collector that never answers cannot hold the run.
  `RunContextRecord` gained `repository` (normalized origin) and
  `workspacePath` (root inside the work tree, from the nearest `.git`
  above it); vx-otel sends them as `vcs.repository.*` and
  `vx.workspace.path`. Rows: `run-context.test.ts` › "names the
  repository and where in it the workspace sits";
  `vx-otel/tests/otel.test.ts` › "a slow collector never holds the run",
  "names the repository".
