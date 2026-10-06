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

# Workstream U — the all-cached run (2026-10-06)

The owner's ask, with a `VX_TIMING=1` table of an all-cached run of this
repo (`vx run build --all`, 16 keys, 107 ms on macOS): "optimize these".
Measured here on Linux with the compiled binary, `run build --all` in two
worktrees of this repo (one per arm, each warmed by its own binary),
fifteen interleaved rounds, min and median per stage. A git config that
weakens stat (`core.checkStat=minimal`) hashes every input from disk, so
the rounds run with `GIT_CONFIG_GLOBAL=/dev/null`.

| stage            | before (min / med) | after (min / med) |
| ---------------- | ------------------ | ----------------- |
| load configs     | 14.2 / 16.5        | 1.9 / 2.2         |
| classify + probe | 20.8 / 23.6        | 16.0 / 17.7       |
| run graph        | 17.3 / 23.6        | 12.6 / 14.2       |
| whole run        | 127.2 / 135.9      | 96.4 / 107.1      |

- **U-1.** Two configs were evaluated on every run: the eval cache's
  purity scan counts every `import` word and refuses a file whose count
  its import forms do not account for, and vx-docs declares a task named
  `import`. `import` followed by `:` is a property key, which no import
  form spells, so it is no longer counted. vx-bench's regex literal (the
  scan refuses any bare `/`) became a string replace. Row:
  `config-cache.test.ts` (a key named `import` is keyed; a member named
  `import` still fails closed).
- **U-2.** `@vzn/vx-mcp` imported its server at load, and every run
  evaluates `vx.workspace.ts`: ~12 ms of the workspace config stage. The
  verb imports it now.
- **U-3.** The filter gate's `git check-attr` waited for `git status`, the
  one spawn that walks the tree, and ran after it (~8 ms here; this repo's
  root `.gitattributes` sets a merge driver). When the index listing alone
  shows an attributes file, it starts beside status. Row:
  `stale-hit.test.ts` (status is held until check-attr starts; the old
  order times out).
- **U-4.** With a telemetry plugin declared, every run spawned git twice in
  series for the run context (~7 ms): `config --get remote.origin.url` and
  `symbolic-ref` for origin/HEAD. The URL is the enumeration's own
  `git var -l`; origin/HEAD is read from its ref file as HEAD already was.
  Each falls back to the spawn. Rows: `run-context.test.ts` (no spawn,
  linked worktree included; a workspace below the repo root still asks).
- **U-5.** A literal output naming a file refused the directory snapshot,
  so its task walked its output glob on every warm hit: vx-docs' `import`
  and `build.playground`. The prefix is recorded as a file (`mtime_ms`
  -2) and holds while a regular file stands there. Rows:
  `output-dirs.test.ts` (recorded and skipped; a tampered file and a
  directory in its place still restore).

Left: `workspace config` is mostly the plugin packages' transpile, half of
it `@vzn/vx-otel` (owned by another thread); `git enumeration` is now the
wait for `git status` it overlaps.
