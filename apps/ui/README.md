# @vzn/vx-ui

The vx dashboard — a Solid SPA that reads a `vx serve` over HTTP.

It builds to a **single self-contained `dist/index.html`** (JS + CSS
inlined; see `vite.config.ts`). `vx serve --ui` embeds that one file
into the `vx` binary via `with { type: 'file' }`, so the dashboard
ships inside `vx` with nothing else on disk.

## Run it

From a built `vx`:

```bash
vx serve --ui --open
```

## Develop

```bash
bun run --filter @vzn/vx-ui dev      # Vite dev server
bun run --filter @vzn/vx-ui build    # produce the single-file dist/index.html
# or, via vx (what the binary build uses):
vx run build.ui
```

`VITE_DEFAULT_ORIGIN` seeds the dev server's connection target; the
header's connection picker overrides it at runtime. The SPA is
platform-agnostic — every read is an HTTP call to a configurable
origin, so the same UI works against a local or hosted `vx serve`.

## Pages

- **Overview** — time saved, hit rate, top time-burners, recent
  failures, cache-by-project, recent invocations.
- **Tasks** — sortable per-(project, task) table (runs, success/hit
  rate, avg/p50/p99, total time, last run).
- **Task detail** — full stats, duration sparkline, latest cache
  entry, recent-run table with CPU + peak RSS.
- **Cache** — entries table (sortable) + by-project bytes breakdown.
- **Run detail** — per-task flamegraph.

## Data source

Everything comes from `vx serve`'s `/v1/*` JSON routes over the
workspace's `cache.db`. No DuckDB, no direct file reads, no build
step in the runner's hot path.
