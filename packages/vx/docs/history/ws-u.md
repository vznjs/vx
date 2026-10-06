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
