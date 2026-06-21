---
title: vx insights — local run dashboard
description: Boot a Solid + DuckDB-WASM SPA against your workspace's cache.db. Historical run flamegraphs, per-task trends, no backend, no daemon.
---

`vx insights serve` opens a localhost dashboard backed by your
workspace's `cache.db`. Pure read-only analytics — no backend, no
upload, no daemon. The page reads SQLite in the browser via DuckDB-WASM.

## Quick start

```sh
cd your-workspace
vx insights serve
```

That prints two URLs:

- The SPA on `http://127.0.0.1:5290` (Vite dev server).
- A tiny static HTTP server (kernel-assigned port) exposing
  `cache.db` at `/cache.db` with the SQLite MIME so the SPA can
  fetch it.

`Ctrl-C` stops both.

Override the SPA port with `--port`:

```sh
vx insights serve --port 7000
```

## What you see

Two pages:

- **Overview** — recent runs list, sorted by start time descending.
  Each row shows project, task name, status, duration, cache
  source. Click a row → run detail.
- **Run detail** — per-task timeline (flamegraph), one lane per
  project, bars colored by status / cache source. The same data
  drives both — replayable in the browser.

## How it works

```
   Browser
   ┌─────────────────────────────┐
   │ apps/insights SPA (Solid)   │
   │  • UnoCSS dark theme        │
   │  • Solid Router (hash)      │
   │  • DuckDB-WASM (~30 MB lazy)│
   └────────┬────────────────────┘
            │ fetch /cache.db
            ▼
   ┌─────────────────────────────┐
   │ Tiny static server (Bun)    │
   │  • cache.db @ vnd.sqlite3   │
   │  • CORS *                   │
   │  • /health                  │
   └────────┬────────────────────┘
            │ reads
            ▼
   ┌─────────────────────────────┐
   │ <workspaceRoot>/.vx/cache/  │
   │  cache.db                   │
   └─────────────────────────────┘
```

DuckDB-WASM reads SQLite files directly via the `sqlite_scanner`
extension — no ETL, no conversion. The SPA `ATTACH`-es the fetched
bytes as a database, runs aggregations client-side, renders Solid
components. Queries stay in the browser.

## What's needed on disk

- `<workspaceRoot>/.vx/cache/cache.db` — at least one `vx run`
  in the workspace.
- `<vx checkout>/apps/insights/` — the SPA source. Set
  `VX_INSIGHTS_DIR` if the installed binary can't find a checkout
  alongside its `import.meta.dir`.

If `cache.db` is missing, `vx insights` prints a clean hint and
exits 1. If the SPA scaffold is missing, the binary points you at
`VX_INSIGHTS_DIR`.

## Why client-side analytics

- **Zero backend.** Nothing to provision, nothing to operate. The
  static server just serves bytes.
- **Privacy by default.** Data never leaves your laptop.
- **Read-only by construction.** The SPA fetches `cache.db` once
  per page load. Mutating queries can't touch your real cache.
- **Open at the data layer.** Anyone can write a DuckDB query
  against `cache.db` directly — the SPA is just a UI on top.

For team-wide analytics, see the
[vx Cloud guide](/vx/guides/vx-cloud/).

## Known limits

- **DuckDB-WASM is heavy** (~30 MB). First query is slow because
  the WASM bundle and SQLite extension download. Subsequent queries
  are fast.
- **No real-time.** The page snapshots `cache.db` on load. Reload
  to see new runs.
- **Charts are minimal today.** The Overview and Run detail pages
  ship; cache hit-rate trends, per-author breakdowns, and the
  "Bottleneck atlas" from the cloud spec are scaffold-pending.

## What's coming

- More pages (per-task trends, cache cliff detection, regression
  surfacing).
- Auto-refresh when `cache.db` mtime changes.
- An option to embed the SPA inside `vx serve` for an in-browser
  live view of running runs.

See also: `docs/design/vx-cloud-2026-06.md` §2.1 (local face),
`apps/insights/README.md`.
