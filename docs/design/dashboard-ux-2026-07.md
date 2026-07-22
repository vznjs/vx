# Dashboard UX v3 — journey-driven IA (2026-07)

Owner directive: "complete rework, 100x more user oriented, UI flows driven,
menu sections data + user-journey oriented, learn from Nx Cloud / Vercel /
Linear, best-UX research, use astryx components — avoid custom."

Research digest (Nx Cloud, Vercel, Linear, GitHub Actions, Buildkite,
Graphite — sourced in the PR): the patterns adopted here are

1. Feed grouped by invocation, not task (Nx CIPE) — one row per `vx run`.
2. Journey-first sidebar top; entity nav below a labeled section (Linear).
3. Master-detail peek panels — never navigate away to read one log
   (Linear space-peek / Nx task panel / Buildkite step panel).
4. Row anatomy: status + environment leading; branch/commit center;
   relative time right-aligned (Vercel deployments list).
5. Failure-diagnosis over raw status: failed rows carry "what should I do"
   chips (flaky / task names), filters filter by diagnosis (Nx).
6. Failed-first ergonomics: failed tasks auto-surface with logs; re-run
   affordances pinned in the header (GitHub Actions).
7. Analytics as ACTION QUEUES led by "time saved": flaky ranked by time
   wasted; cache ranked by lowest hit rate; percentiles not averages (Nx).
8. Detail pages are hubs: every row cross-links laterally (task history,
   cache entry) (Vercel).
9. The feed IS the home — no separate overview/activity split (Vercel
   deleted their activity stream; the deployments list won).

## IA

```
vx  [wordmark]                       ── header, ⌘K hint
  Activity            /             ── the runs feed (home)
  Needs attention     /attention    ── inbox: failing + flaky + slow (badge)
  Cockpit             /run          ── live run (only when workspace-colocated)
INSIGHTS
  Speed               /insights/speed   ── bottlenecks + percentiles + parallelism
  Cache               /insights/cache   ── time saved + hit-rate action queue
  Flaky tasks         /insights/flaky   ── ranked by time wasted, retry suggestions
WORKSPACE
  Projects            /projects
  Tasks               /tasks
[footer: connection · workspace · theme]
```

Legacy routes redirect: /runs→/, /overview→/, /bottlenecks|/trends→
/insights/speed, /cache→/insights/cache. /runs/:id, /compare/:id,
/projects/:name, /tasks/:id keep working.

## Pages

- **Activity (home)** — astryx `table-grouped` archetype: PowerSearch
  (status/branch/CI filters) + SegmentedControl (All/Failed/Passed),
  runs grouped into collapsible Today/Yesterday/This week/Earlier
  sections, Vercel row anatomy, failed rows carry diagnosis chips.
  Click → resizable inspector panel (summary, failed tasks, open-full
  link); full detail one more click.
- **Needs attention** — the inbox: Failing now / Flaky (retry suggestion +
  time wasted) / Slowest offenders / Worst cache hit-rates, each row
  deep-linking to its fix surface. Nav badge = failing+flaky count.
- **Run detail** — TabList: Summary (facts + KPIs + failed tasks
  auto-expanded with logs + key diff) · Tasks (searchable, state-grouped,
  peek panel) · Graph · Timeline. Header: status + id + branch/commit +
  relative time.
- **Insights ×3** — action queues per pattern 7.
- **Projects/Tasks** — searchable-table archetype (PowerSearch + toolbar).
- **Cockpit** — unchanged this wave (already flow-driven).

Component mandate: astryx `table-grouped` / `detail-page` / `editor`
templates as scaffolds; PowerSearch, SegmentedControl, TabList,
Collapsible, MetadataList, LayoutPanel+ResizeHandle, List/Item, Timestamp,
Token/StatusDot, EmptyState. No custom widget where a template/block exists.
