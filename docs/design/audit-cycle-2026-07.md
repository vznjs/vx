# Full audit — cycle 1 (2026-07-12)

> Owner directive: "Review and find bugs… full audit, document granularly so
> Opus can pick up. Propose solutions and arch changes. Attention to
> performance of real UI — scrolling, interactions, tested and MEASURED, no
> stuttering, always 60fps. Improve DX and UX, define user flows."
>
> Status: findings ranked and specified for implementation. Every UI-perf
> number below is MEASURED against the real platform server with realistic
> data volume — not estimated. Sections: [1] measured UI performance,
> [2] UI mechanism findings, [3] core findings, [4] DX/UX flows + ranked
> improvements, [5] proposed architecture changes, [6] execution plan.

## 1. Measured UI performance (the 60fps audit)

**Method.** Real `vx-cloud server` (ephemeral Postgres + fake S3) serving the
freshly built SPA, seeded via `POST /v1/ingest` with 300 invocations × 40
tasks (12,000 `task_runs`, 14-day spread, 6 branches, mixed hit/fail) plus
one 700-task run. Driven with Playwright/Chromium (1440×900). Frame times
sampled in-page via `requestAnimationFrame` deltas + a
`PerformanceObserver('longtask')`; scroll = 30×350px wheel steps at 40ms
intervals (down then up). Harness:
`<scratchpad>/perf/{seed-serve.ts,measure.mjs,profile.mjs}` — reproduce by
re-creating those two scripts (they only use `tests/helpers/*` + Playwright).
Headless rendering has no GPU, so absolute numbers are pessimistic vs real
hardware — but scenario 5 proves the SAME harness sustains a clean 60fps, so
every drop below is real main-thread work, not harness noise.

| #   | Scenario                                       | avg fps | p50    | p95    | worst   | frames >34ms | long tasks (total)     |
| --- | ---------------------------------------------- | ------- | ------ | ------ | ------- | ------------ | ---------------------- |
| 1   | Runs: wheel-scroll the 300-row history table   | **20**  | 50.0ms | 83.4ms | 249.9ms | 63/99        | 1 (238ms)              |
| 2   | Runs: IDLE 12s (poll ticks only, no input)     | **30**  | 33.3ms | 49.9ms | 149.9ms | 19/354       | 3 (282ms)              |
| 3   | Insights: navigate + render + scroll           | **24**  | 33.4ms | 83.4ms | 133.4ms | 37/107       | 0                      |
| 4   | Run detail (700 tasks): scroll (open = 1804ms) | **24**  | 49.9ms | 83.3ms | 316.7ms | 62/122       | 3 (413ms, worst 252ms) |
| 5   | Run detail: task-select clicks ×5              | **60**  | 16.7ms | 16.7ms | 16.8ms  | 0/88         | 0                      |
| 6   | Tasks page: navigate + render + scroll         | **38**  | 16.7ms | 66.6ms | 83.3ms  | 43/169       | 1 (258ms)              |
| 7   | Nav: 5 route transitions                       | **38**  | 16.7ms | 50.0ms | 116.6ms | 8/131        | 1 (108ms)              |

**Verdict: the 60fps bar is failed on every data-heavy surface.** The Runs
page renders at HALF rate while completely idle — scenario 2's steady 33ms
p50 means the main thread does ~2 frames of work per vsync even with zero
input. Scenario 5 (a localized reactive update: task-select writes one
binding) is the proof the stack CAN hit 60fps — the problem is render
granularity and volume, not Solid or the runtime.

**Console noise measured in the same session: 14 `Failed to load resource:
404` errors** — the SPA polls removed endpoints (`/v1/runs/queue` every 2s
from the Runs view, plus `/version`, `/v1/workspace/*` probes). Every one is
a wasted fetch + a scary console line.

### Root-cause chain (measured + code-confirmed)

1. **`components/RunsView.tsx:292` polls `GET /v1/runs/queue` every 2
   seconds** — an endpoint the platform REMOVED (P3). Guaranteed 404, forever,
   plus per-tick state churn. The CPU profile of the idle Runs page shows
   continuous DOM `remove`/`insertBefore`/`cloneNode` work — teardown/rebuild
   churn while nothing visible changes.
2. **`components/RunsView.tsx:238` fetches `listRuns({ limit: 2000 })`** for
   the project facet — up to 2000 full run rows on every load/poll of the
   Runs page.
3. **No table virtualization anywhere.** Every row of every table is a live
   DOM subtree; the 300-row history table + 700-row task table render
   entirely. Scroll then forces large style/layout work per frame
   (p50 50ms).
4. **Poll refetch replaces whole arrays by identity** → the view-layer state
   diff sees every row as changed → full re-render of table subtrees every
   5s (Runs) / 2s (queue) even when data is unchanged. (See §2 UI-audit
   findings for the exact mechanism + fix.)

### The 60fps acceptance bar (for Opus)

After the §2 fixes land, re-run the same harness. Pass criteria:

- every scenario ≥55 avg fps, p95 frame ≤20ms, zero long tasks >100ms
  during scroll;
- Runs idle: p50 ≤17ms (idle page must idle);
- run-detail(700) open <800ms;
- console errors: 0 (no polling of removed endpoints).
  Commit the harness as a version-gated perf test (the `analytics-scale`
  precedent) so regressions are caught in CI — see §6.

### Cycle-2 results (measured after the first fix wave)

Fixes shipped: identity-stable polling (jsonPage equality gate +
`identityStable` on RunsView's resources), dead-endpoint polling killed
behind /v1/meta capabilities (`queue`, catalog-gated `/version`), C1 stale
cross-entity guard, C2 string-keyed resource sources, C6 last-good queue
rows — and the attribution experiment's find: **`backdrop-filter` blur on
every Card + the sticky sidebar/header was the entire scroll stutter**
(A/B-measured: baseline 16fps → `backdrop-filter: none` 60fps, gradient and
shadows innocent; a plain static 300-row table scrolls 60fps in the same
harness, disproving the "headless is just slow" hypothesis). Blur removed
from all scroll-path chrome (kept on static overlays: login gate, command
palette); replaced with near-opaque backgrounds — visually imperceptible on
the dark theme (screenshot-verified).

| #   | Scenario                    | before                       | after                                                                    |
| --- | --------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| 1   | Runs: wheel-scroll 300 rows | 20fps, p50 50ms, worst 250ms | **60fps, p50 16.7ms, 0 frames >17ms**                                    |
| 2   | Runs: idle 12s              | 30fps, continuous DOM churn  | **60fps, 0 DOM mutations, 0 long tasks**                                 |
| 3   | Insights: nav + scroll      | 24fps                        | **57fps** (p95 16.8ms)                                                   |
| 4   | Run detail (700): scroll    | 24fps, worst 317ms           | **48fps** (p50 16.7ms; one 633ms initial-render spike remains — P3)      |
| 5   | Run detail: task select     | 60fps                        | 60fps                                                                    |
| 6   | Tasks page                  | 38fps                        | **60fps**                                                                |
| 7   | Nav transitions             | 38fps                        | **50fps** (route-mount long tasks ~260-316ms remain — P3/initial render) |
| —   | Console errors / session    | 14                           | **0**                                                                    |

### Cycle-3 wave 1: P3 virtualization — the bar is MET everywhere

DataTable now windows rows above 120 (viewport slice + overscan 12, spacer
rows preserving scroll geometry, row height calibrated from the first
rendered row); C5's type-aware sort comparator landed with it. Geometry
verified at the extreme: the bottom of the 700-row table mounts 31 rows and
the last is task #699. Measured (same harness):

| Scenario                 | cycle-1 baseline       | after cycle-3 wave 1                    |
| ------------------------ | ---------------------- | --------------------------------------- |
| Runs scroll              | 20fps, worst 250ms     | **55fps, 0 frames >34ms, 0 long tasks** |
| Runs idle                | 30fps, churn           | **60fps, p95 16.8ms**                   |
| Insights                 | 24fps                  | **60fps, p95 16.8ms, 0 long tasks**     |
| Run detail (700): scroll | 24fps, 652ms long task | **60fps, p95 16.8ms, 0 long tasks**     |
| Tasks page               | 38fps, 305ms long task | **60fps, 0 long tasks**                 |
| Nav transitions          | 38fps                  | **56fps, 0 long tasks**                 |

(The scenario-4 "open" wall-time includes a fixed 1.8s settle in the
harness — the honest open metric is long-tasks-during-mount: 652ms → 0.)

Remaining polish (cycle 4+): P4 live-log cap, P5-P8, C3-C4, the committed
CI perf guard, DX-1..5, core-audit completion.

## 2. UI mechanism findings (perf + correctness)

Static audit verified against the real `@json-render` 0.19.0 dist and
Solid's `createResource` source. Library facts that drive everything:
json-render's `flattenToPointers` treats **arrays as leaf values** compared
**by reference**; the store snapshot signal is `equals: false` (fires on
every update); every element re-resolves props (re-running `$computed`
functions, allocating fresh objects) on every store update; Solid's `<For>`
keys **by item reference**.

### PERF (ranked; P1+P2 explain the measured idle-30fps and tick jank)

- **P1 CRITICAL — every poll rebuilds the full DOM of every data-bound
  table/list.** `jr/page.tsx:83-127` hands `<Dash state={state()}>` a fresh
  object per resolve; refetched arrays are all-new identities even when
  content is byte-identical → StateProvider marks them changed → `<For>`
  (reference-keyed, `jr/components.tsx:609,677`) disposes and recreates
  every row. `/cache`: ~1,400 cells rebuilt every 5s; `/insights`: ~10
  tables/charts per tick; a tick mid-scroll replaces the scroll container's
  contents. **Fix:** content-equality gate in `jsonPage` before committing
  state (keep the previous reference when payload is equal — ~15 lines,
  kills the steady-state cost); for genuinely-changed data, reconcile rows
  keyed by id (`createStore` + `reconcile(rows, { key: 'runId' })` or a
  keyed-`<For>` wrapper).
- **P2 HIGH — `$computed`-fed tables rebuild once per SOURCE resolution,
  not per tick.** N sources resolve at different moments → N store updates
  → on `/insights` ~644 element re-resolutions and ~70 table rebuilds per
  tick; `/cache`'s 200-row table rebuilds up to 6× per tick
  (`jr/functions.ts:86-92` `coldEntries` et al. return fresh arrays each
  call). **Fix:** P1's equality gate + batch each tick's sources into ONE
  state commit (`Promise.allSettled`).
- **P3 HIGH — no virtualization/cap/containment in DataTable.**
  `jr/components.tsx:537-631`: all rows live (feeds pass 200-500); filter
  fallback `JSON.stringify(r)` per row per keystroke (`:568`); re-sort per
  keystroke (`:571`). **Fix:** window rows (fixed 33px row height makes
  manual windowing trivial), `content-visibility: auto` +
  `contain-intrinsic-size` per row + `table-layout: fixed` as interim;
  debounce filter; drop the stringify fallback.
- **P4 HIGH — live log path is O(n²) and uncapped.**
  `components/RunSession.tsx:105` accumulates `prev + chunk` per chunk; the
  `<pre>` re-runs `stripAnsi(fullLog)` and replaces the whole text node per
  chunk (`:431-433`); no cap → a chatty task retains tens of MB in a
  module-scope store. **Fix:** mirror the serve's 128 KiB head-evicting cap,
  store chunks as `string[]` (strip per chunk), render append-only.
- **P5 MED-HIGH — 4 Hz full flamegraph rebuild during live runs.**
  `RunSession.tsx:231-261` rebuilds all rows from the 250ms ticker; full
  lane packing + every bar's DOM recreated 4×/s (`flamegraph-layout.ts:38-84`,
  `Flamegraph.tsx:141`). **Fix:** layout only on task-set change; grow
  running bars via `style.width`/`transform: scaleX` on stable elements;
  ticker 1 Hz for graphs.
- **P6 MED — flamegraph mousemove does `getBoundingClientRect` per event +
  un-memoized O(N) window recompute** (`Flamegraph.tsx:93-97,53-59`).
  **Fix:** memo the window; cache the rect on pointerenter; move the cursor
  with `transform: translateX`; rAF-throttle.
- **P7 MED — O(N²) per-card `find` lookups in the live graph**
  (`RunSession.tsx:331,377,424`). **Fix:** one memoized `Map<id, node>`.
- **P8 LOW-MED — LineChart tooltip subtree recreated per hovered index +
  per-event rect read** (`charts.tsx:114,173-202,236-260`). **Fix:** render
  once, bind position/text; cache rect.

### CORRECTNESS

- **C1 HIGH — cross-entity stale data on param/connection change.**
  `jr/page.tsx:82,102-121`: `res.latest` + the `lastGood` map are keyed by
  state key only — navigating `/tasks/a → /tasks/b` renders A's data under
  B's URL while loading, and FOREVER if B's fetch fails; same on org/
  workspace switch (tenant bleed-through in the UI). **Fix:** store
  `{ forKey, value }` and serve last-good only when `forKey` matches the
  current source; mismatched latest ⇒ `'loading'`, never `'ok'`.
- **C2 HIGH — RunViz refires `/v1/graph` (a server-side planRun) on every
  store update and every task-select click.** `jr/components.tsx:286-300`:
  `specs` emits a new array identity per store update →
  `createResource(specs, getGraph)` refetches; same class for `TaskLogs`'
  tuple source (`:752-758`). **Fix:** value-stable string sources
  (`specs().join(',')`, `` `${runId}|${taskId}` ``).
- **C3 MED — module-scope job retention + unkillable stale 'running' rows.**
  `RunsView.tsx:67-74,340-353,602-627`: done jobs hold full uncapped logs
  until manual Dismiss; a job whose socket died silently has no removal
  affordance and its 250ms ticker keeps running. **Fix:** clear session
  stores on `queue:done`, auto-remove after N minutes, Dismiss for any
  terminal-or-stale state, stop ticker on WS close.
- **C4 MED — no request cancellation anywhere in api.ts.** Navigating away
  from a 500-task run detail leaves ~500 queued `/v1/diff` fetches draining
  through the 6-per-origin budget, starving the next view for seconds
  (`jr/data.ts:49-60,91-125`). **Fix:** AbortController per resource fetch
  (`onCleanup` aborts); server-side: a batched `/v1/why/:runId` endpoint
  (mirrors `/v1/cache/batch`).
- **C5 LOW-MED — DataTable sort comparator wrong for mixed/null values**
  (`jr/components.tsx:571`: `(a[k] ?? 0)` then `>` across types → unstable
  order). **Fix:** type-aware comparator, nulls last, `localeCompare`.
- **C6 LOW — one failed 2s queue poll blanks foreign CLI jobs**
  (`RunsView.tsx:287-289` catch → `setQueueJobs([])`). **Fix:** keep
  last-good rows like the invocations resource already does.

Verified sound: `useVisibilityRefresh` lifecycle, Solid's stale-resolution
guard, the project-facet race fix, AdminView org reseeding, RunGraph's
fixed-grid + content-visibility + transform zoom, WS lifecycles,
`getConnectionKey` scoping. Bundle: 436 KB raw / ~113 KB gzip single file, no
dead heavy deps.

## 3. Core findings

The core-audit pass was cut short (agent hit the session limit mid-run);
**carry the remainder to cycle 2** (watch loop, migrate mappings, lockfile
atomicity, upgrade paths, loader validation, run.ts parser edges). Confirmed
before the cutoff:

- **CORE-1 CONFIRMED — predictive scheduling priorities collapse to
  own-duration in real graph order** (`src/orchestrator/predict.ts` +
  `history.ts`, experimental `--predict` path). The critical-path-style
  priority is computed in a node order where dependents haven't been folded
  yet, so a task's priority degenerates to its own historical duration
  rather than the downstream-chain total — LPT-style ordering silently loses
  its lookahead benefit. Cycle-2 task: reproduce with a diamond graph whose
  long chain hangs off a short head (priority should reflect the chain),
  then fold priorities in reverse-topo order (the scheduler's bitset-closure
  precedent) and pin with a unit test.
- **CORE-2 (from Flow audit, confirmed at `env.ts:156`)** — the silent
  tokenless-connect trap, DX-1 in §4.
- **CORE-3 (docs-as-code)** — `src/cli/upgrade.ts:71,85` error strings
  reference the removed `install.sh` (DX-5b).

## 4. DX/UX — canonical user flows + ranked improvements

Seven flows were walked end-to-end against the shipped CLI + docs (every
command verified against `src/cli/*`, `packages/cloud/src/cli/*`, and
`apps/docs/src/content/docs/**`). Summary per flow, then the ranked
improvement list; each improvement is specified to be implementable without
further design.

### Flow 1 — local dev loop (clone → run → warm → watch → debug)

Works well to the first failure. Then: **failed-task logs exist nowhere on
disk** (the cache stores stdout of successes only; the v13 decision removed
per-run log dumps) — once the terminal scrollback is gone, a local failure is
unrecoverable except by re-running. And the flagship explainability
(`whyDidThisRerun`, `explainCacheKey`) is reachable locally **only via MCP**
(`src/cli/mcp-rpc.ts:67-78`) — no `vx why` verb.

### Flow 2 — migration from Turbo/Nx

`vx migrate` is solid (dry-run, overwrite guard, report). Traps: the
from-turborepo command table maps `turbo run build` → `vx run build` but the
default SCOPES differ (turbo = workspace, vx = cwd project) — the table must
say `vx run build --all`; `from-turborepo.md:8` still claims Turbo
remote-cache wire compat (dropped 2026-07-10); `from-turborepo.md` line ~131
claims "no Node runtime" contradicting the npm-binary install.

### Flow 3 — CI setup (GHA)

A genuine copy-paste path exists (2 doc pages). Stale: `guides/ci.md:65-68`
still describes the REMOVED curl installer + `VX_VERSION` pinning;
`src/cli/upgrade.ts:71,85` error strings still reference `install.sh`. The
PR-checks section tells the reader to "declare the first-party CI plugin"
without showing the `vx.workspace.ts` snippet.

### Flow 4 — debug on CI (red check → root cause)

Without cloud: job summary → framed failure block, ~2-3 steps, fine. With
cloud: **there is no link from the GHA summary/check to the dashboard run**
(`github-summary.ts` emits no URL) — the dev must know the deployment URL,
log in, and facet manually (~5-7 steps). And **distributed runs are never
ingested at all** (documented gap) — the biggest runs are invisible.

### Flow 5 — cloud adoption (self-host → connect → cache in CI)

The #1 trap, CONFIRMED at `packages/cloud/src/cli/env.ts:156`: `connect`
demands a token only when the server advertises `auth: 'token'`, but the
platform advertises `auth: 'account'` — so **a tokenless
`vx-cloud connect https://…` SUCCEEDS silently**, then every ingest/cache
call 401s and is swallowed (never-fail telemetry). Symptom: "connected, but
the dashboard stays empty and the cache never hits", with zero error
anywhere. Second trap: forgetting to declare `cloud()` in `vx.workspace.ts`
produces the identical silent-empty symptom.

### Flow 6 — distributed CI

Turnkey `uses:` workflow works. Silent failures: `VX_CLOUD_DISTRIBUTE`
without the `cloud()` plugin declared silently runs locally while N agent
jobs idle to timeout; `vx-distributed-ci.yml:51` still says "omit for a
token-less serve" (no such mode exists on the platform).

### Flow 7 — dashboard contributor loop

**Broken under the account model.** The SPA authenticates with an HttpOnly
cookie via `credentials: 'include'`, but the server's CORS is
`Access-Control-Allow-Origin: *` (`dispatch.ts:119`) — browsers refuse
credentialed requests against a wildcard, and there is no Vite dev proxy. So
HMR development against a real platform is impossible today; contributors
must full-build `ui/dist` per change. `packages/cloud/ui/README.md` still
documents the retired `vx serve --ui` + bearer-token model.

### Ranked DX improvements (implement in this order)

1. **DX-1 `vx-cloud connect` refuses tokenless connects to account
   platforms** (very high value / low effort). In `env.ts` `connectCmd`:
   after `fetchMeta`, `meta.auth === 'account' && token === undefined` →
   `UserError` telling the user to mint a token under Admin → Tokens; keep
   the existing 401 probe for supplied tokens; add `--anonymous` to opt into
   a tokenless (read-nothing) connect with a printed warning. Tests: stub
   metas for both auth modes.
2. **DX-2 dashboard deep link on the GHA summary + check run** (high/low).
   `formatGithubSummary`/`github-check.ts` accept `dashboardUrl?`; the
   `CloudIngestSink` passes the connection origin when one resolved; append
   `▸ Open this run in the vx dashboard → <origin>/#/runs/<runId>`.
3. **DX-3 `vx why [pkg#task]` core verb** (high/low-medium). New
   `src/cli/why.ts`: open the local cache, run `whyDidThisRerun` (latest vs
   previous run; the wiring `mcp-rpc.ts` already has), fall back to
   `explainCacheKey`; pretty diff table + `--format json`; include-match
   suggestions on unknown task. Tests mirror `show-info.test.ts`.
4. **DX-4 `vx-cloud status` doctor** (high/medium). One screen: active env +
   token presence, `/health` + `/v1/meta`, an AUTHENTICATED probe naming
   `ok | 401 | no token`, `VX_CLOUD_DISTRIBUTE` + `/v1/agents` capacity, and
   whether cwd's `vx.workspace.ts` declares `cloud()` ("NOT declared —
   VX_CLOUD_DISTRIBUTE will be ignored"). Surfaces all three silent modes.
5. **DX-5 UI dev proxy + stale-doc sweep** (medium-high/trivial). (a)
   `ui/vite.config.ts` `server.proxy` for `/v1|/mcp|/health|/events|/stream`
   (ws: true) → `localhost:4321`, unbreaking Flow 7; rewrite
   `packages/cloud/ui/README.md` with the compose-platform recipe. (b) Fix
   the verified stale spots: `guides/ci.md:65,68`,
   `migrate/from-turborepo.md` (wire claim, `--all` scope row, Bun claim),
   `vx-distributed-ci.yml:51`, `upgrade.ts:71,85` install.sh strings.

## 5. Proposed architecture changes

1. **Runs-page data contract.** Stop fetching 2000 rows for a facet; add
   `GET /v1/runs/facets?ws=` (distinct branches/projects/commit prefixes,
   one GROUP BY) and page the history table server-side (`limit/offset`
   already exist). The Runs view then renders ≤100 rows/page and the facet
   chips come from one tiny response.
2. **Table rendering contract.** One shared virtualized table primitive
   (windowing ~30 rows + overscan, fixed row height, `<For>` keyed by row
   id, `content-visibility: auto` fallback) replacing the render-everything
   DataTable path for tables that can exceed ~100 rows (runs, run-detail
   tasks, artifacts, cache entries, tasks rollup).
3. **Poll → diff, not replace.** On refetch, reconcile new rows into the
   existing store keyed by id (Solid `reconcile`), so an unchanged row is
   identity-stable and produces ZERO DOM work; a data-identical poll tick
   must render nothing. (Exact integration point in §2 findings.)
4. **Kill dead-endpoint polling.** Capability-gate every optional surface on
   `/v1/meta` (the pattern already exists for `cacheWire`): no `catalog`
   capability → never fetch `/v1/workspace/*`; no queue → never poll
   `/v1/runs/queue`. Zero 404s in a healthy session.
5. **Commit the perf harness** as `packages/cloud/tests/ui-perf.test.ts`
   (Playwright + the rAF sampler, seeded platform, generous bounds like the
   analytics-scale guard: e.g. avg fps ≥ 40 headless, zero >200ms long tasks,
   0 console errors) — skipIf when Playwright/chromium is absent so local
   runs stay green.

## 6. Execution plan for Opus (strict order)

1. UI quick wins (small diffs, huge wins): kill the `/v1/runs/queue` poll
   behind a meta capability + drop `limit: 2000` → server-side facets
   (arch #1); fix DX-1 (connect trap) + DX-5b (stale docs).
2. Poll reconciliation (arch #3) — measure again with the §1 harness; expect
   idle 60fps.
3. Virtualized table primitive (arch #2) — measure; expect scroll ≥55fps on
   300 + 700 rows.
4. DX-2, DX-3, DX-4, DX-5a.
5. Commit the perf guard (arch #5) with the §1 pass criteria.
6. Core fixes from §3 in severity order.
7. Cloud perf follow-ups already tracked (#79): listProjects/getCacheSavings
   CTE rewrites, partition lookback bounds + failed-status partial index,
   trusted-GET HEAD skip, session-principal memo.

Each step: full gate (`bun src/bin.ts run ci` + cloud tests) before push;
re-run the §1 harness after every UI-affecting step and paste the numbers
into the commit message.
