# @vzn/vx-insights

Local SPA over `cache.db` — read-only analytics for your vx runs.

## What this is

A Solid + UnoCSS + Vite app that loads DuckDB-WASM in the browser, ATTACHes
the local SQLite `cache.db` via the `sqlite_scanner` extension, and runs
typed queries against it for the run history and per-task flamegraphs.

No backend. No ETL. Pure client-side analytics over the same database `vx
run` writes to.

## Run it

The intended entry point is the CLI:

```bash
vx insights serve
```

which boots both this SPA's dev server (port 5290 by default) and a tiny
static file server that exposes the workspace's `cache.db` to the
browser via the `VITE_CACHE_DB_URL` env var.

Standalone (for development of the SPA itself):

```bash
bun --cwd apps/insights install
bun --cwd apps/insights run dev
```

The SPA will look for `cache.db` at the path in `VITE_CACHE_DB_URL`, or
fall back to `/cache.db` on the same origin.

## Build

```bash
bun --cwd apps/insights run build
# dist/ is the static bundle
```

## Architecture notes

- **DuckDB-WASM is large (~30MB).** It loads lazily on the first query.
  The Overview page shows a loading state during the bootstrap.
- **DuckDB reads SQLite directly** via the `sqlite_scanner` extension —
  no ETL, no schema rewrites. The same DB `vx run` writes to is the DB
  the SPA reads.
- **Read-only.** The SPA never writes to `cache.db`. The SQLite handle
  on the browser side never opens with a write flag.
- **No build step in the orchestrator's hot path.** `vx insights serve`
  fails loud with a build hint if `apps/insights/dist/` is missing
  rather than silently falling back to something else.
