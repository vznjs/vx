# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`packages/vx-bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped — the record

The review arc (2026-09-02 → 09-09) and improvement-loop items 1–64,
with the bench numbers behind them, moved whole to
`docs/history/2026-09-review-arc.md` on 2026-09-10, items 65–104 to
`docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, and
items 105–144 to `docs/history/2026-09-improvement-loop-105-144.md` on
2026-09-16 (with the Next list's record to
`docs/history/2026-09-status-next-log.md` the same night), so this file
stays the handoff and not the log; numbering continues from there. Keep
it that way: when the loop below passes forty items, move the oldest
batch there in one commit, and move a Next entry's record the same way
once it is closed.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

145.  DONE (2026-09-11 — Next 15's first gap): `--mjs` on `vx init` and
      `vx-migrate`. The seam's `format` (`ts` | `mjs`) names the files
      (`vx.config.mjs`, `vx.workspace.mjs`, the Turbo preset
      `vx-preset.mjs` with its import specifier) and renders the same
      objects with no type import and no `satisfies`; the report and
      the example follow. Why: a package whose `tsconfig` includes
      every `.ts` under it compiles a generated `vx.config.ts` into its
      dist — TanStack/query's `tsc --build` failed on the type import in
      every sibling — and the bench had to rewrite the configs by hand.
      Pinned in `init.test.ts` and the Turbo suite (the `.mjs` files
      load through `loadProjectConfig`). The watch e2e flake (Next 5)
      showed again on this item's suite runs: `workspace-root lockfile
changes trigger a cycle` lost its 45 s window once alone on an
      idle box and passed five of five right after, with and without
      this change.

146.  DONE (2026-09-11 — Next 15's second gap): two targets on one output
      path resolve at migration time. vx cleans a task's outputs before
      it runs and before a restore, so the loader refuses two cached
      tasks whose outputs provably overlap — and strapi's `build`,
      `build:code` and `build:types`, all on `dist/**`, met that refusal
      at load time after a clean migration report. `resolveSharedOutputs`
      in `@vzn/vx-migrate`, after both mappers: the loader's own
      conservative overlap test (equal literals, a literal a glob
      matches, identical globs), the task with a `^` edge keeps its
      cache (the first declared when none has one), every other task on
      that path runs uncached with a todo naming the keeper and the
      fix. Pinned as a unit (the strapi shape, the disjoint-prefix
      case the loader lets through, tasks without cache) and in the Nx
      fixture (`pkg-b#build:types` on `build`'s `out`).

147.  DONE (2026-09-11 — Next 15, storybook's prerequisite): an
      `nx:run-commands` target runs where Nx ran it, with its
      placeholders expanded. Nx runs those commands from the WORKSPACE
      ROOT unless `cwd` says otherwise and interpolates `{projectRoot}`,
      `{projectName}` and `{workspaceRoot}`; the mapper emitted the
      string verbatim into a task vx runs from the project dir, so a
      root-relative command (storybook's `node ./scripts/build/
build-package.ts --cwd {projectRoot}`, novu's `npx biome lint
apps/worker`) found nothing, and `cwd: '{projectRoot}'` earned a
      spurious todo. `nxRunCommand` expands the three placeholders and
      prefixes the `cd` from the project dir to where Nx ran it (none
      when that is the project dir; `{args.*}` is a todo — params
      forwarding). A plain `command` is the same shorthand. Pinned as a
      unit (storybook's `compile`, a `{projectRoot}` cwd, a declared
      sub-directory, the root project) and in the Nx fixture, where
      the run-commands pins now carry the `cd` (three fail on the
      previous mapper).

148.  DONE (2026-09-11 — Next 5, the watch e2e flake): the arm instant
      is read off the mtime clock. A first-sighted path is a change
      only if it moved since the watchers went live, judged by its
      mtime against `armedAt`; `armedAt` was `Date.now()`, the fine
      clock, and an mtime is the kernel's coarse clock, up to a tick
      behind — measured here: 2 of 3,000 tight writes carried an mtime
      5.8 ms EARLIER than a `Date.now()` taken before the write, and
      more under CPU load, where the tick is skipped. So an edit made
      right after the ready line was judged the initial run's and
      dropped, and the loop waited forever: three shard runs lost a
      45 s window that day, and the reproduction (four CPU burners,
      `scratchpad/watch-probe.sh`) failed 3–5 of every 6 runs, the
      traced failures reading raw event → trigger → `same=true` on the
      edited file. `fsClockNow(cacheDir)` writes and removes a stamp
      under the cache dir and returns its mtime, so both sides of the
      comparison share one clock and every later write is at or after
      it; the same-tick case reads as a change (one benign extra cycle
      on the macOS late-delivery path the rule exists for). Pinned in
      `watch-rules.test.ts` (2,000 writes right after the stamp, none
      "before" it; the stamp removed; an older file still before) and
      by the probe: 12 of 12 loaded runs green on the fix, 0 of 24 test
      executions lost, against 0 of 24 idle and 3 of 24 loaded before.
      The e2e timeouts carry the watch's stdout and stderr (PR #310)
      so the next miss names itself.
149.  DONE (2026-09-11 — Next 15, found by the fourth Nx repo): a
      workspace peer orders the build unless it would close a cycle.
      Item 137 made every `peerDependencies` entry reach only (a peer
      is the consumer's to provide), and TanStack/router refuted the
      half of that claim that matters for order: `router-devtools-core`
      peers on `router-core`, pnpm links the peer into the package's
      own `node_modules` (`linkWorkspacePackages`; bun, npm and yarn
      hoist it to the root, where it resolves just the same), the build
      type-checks against the peer's `dist`, and Nx orders `^build` on
      the edge — vx built the devtools first and failed (77 of 85 on
      the cold probe, 9 skipped downstream). The rule now: order edges
      are the three hard fields, the task edges, and each workspace
      peer that does not reach the package back through the order
      edges so far, tried in (package, peer) name order so a mutual
      peering keeps the same edge on every run; a peer that would
      close a cycle stays reach only (medusa's shape from item 137,
      still runnable, still affected). Pinned in
      `tests/package-graph.test.ts` (the four-field pin flipped; the
      peer-behind-a-dev-dep and mutual-peering differentials; the
      medusa pin kept) and on router: the plan carries
      `router-core#build` under the devtools build. Warm path: an
      interleaved A/B of compiled binaries on the 1,000-project bench
      (no peers there — the cost is one sort and an empty pass), 12
      reps: base min 199 / median 203 ms, head 195 / 205. A tie.
150.  DONE (2026-09-11 — Next 15, the fourth Nx repo): TanStack/router
      benched, `build test:build` = 85 tasks at the repo's
      `parallel: 5`, medians of three: cold 199.9 s vs Nx 23.2.0's
      226.7 s, restore 1.00 s vs 3.33 s, no-op 505 ms vs 3.21 s
      (`docs/benchmarks.md`, `REPOS.md`). Two things the repo taught:
      the peer order edge (item 149), and Nx 23's cache living per
      user under `~/.nx/<workspace id>/`, outside anything the
      harness's clean sees — rep 2's Nx cold arm read 85 of 85 hits
      from it (5.0 s) and is not in the medians; `nx-repo.sh` pins
      `NX_CACHE_DIRECTORY` inside the repo since, and an Nx-only rep
      on the pin (224.1 s cold, the cache under `.nx/cache`, nothing
      under `~/.nx`) replaced the row. The install is the packages,
      benchmarks and root filters only (1 GB; the examples pull every
      framework and are out of the repo's own scope anyway).
151.  DONE (2026-09-11 — from router's configs): the Nx mapper's
      directory heuristic took a leading dot for an extension, so
      `{projectRoot}/.output`, `.netlify` and `.wrangler` (router's
      `build` outputs; Nx's own plugins declare `.next` and `.nuxt` the
      same way) were written bare while `dist` became `dist/**`. A bare
      name for a directory saves nothing — the output scan lists files
      and symlinks, never a directory itself — so a hit would have
      restored no `.output`, the stale-hit class in a generated config.
      Only a dot past the first character marks a file now; pinned in
      `migrate.test.ts` (`.output` → `.output/**` beside `lcov.info`
      kept), documented in the package README.
152.  DONE (2026-09-11 — Next 15, the fifth Nx repo): refinedev/refine
      benched, the 35 library `build` tasks at Nx's default
      `parallel: 3`, medians of three: cold 104.2 s vs Nx 18.2.2's
      115.3 s, restore 636 ms vs 2.23 s, no-op 184 ms vs 2.11 s
      (`docs/benchmarks.md`, `REPOS.md`). Out of both tools: the
      examples (the repo's own scope) and its two Next apps —
      `refine-ui`'s build fetches Google Fonts (no egress here) and
      `live-previews` is one 280 s `next build`. `types` shares
      `dist/**` with `build`, so item 146 leaves it uncached under vx
      while Nx caches it: not benched. The mapper wrote the repo's
      `{projectRoot}/.next` output as `.next/**` (item 151). Nx round
      closed at five repos (owner: 3–5): query, strapi, novu, router,
      refine.
153.  DONE (2026-09-11 — the real-repo no-op, profiled): vx reports
      76 ms of refine's 183 ms no-op wall and 293 of router's 513, so
      the rest was measured on refine with `VX_TIMING=1` (three runs,
      180 ms wall, the table's 162 ms): startup 27, git enumeration 34,
      classify + probe 34 (the 35 task hashes 24, the batched probe
      8), run graph 42, record history 5, and ~15 ms of Bun boot before
      the first mark (`--version` is 20 ms wall; the tail after the
      table is 7 ms under strace). Discovery and config load are 10 ms
      for 206 projects. The run graph's 42 ms is the output proof:
      6,790 output files under 35 `dist/**` (median 70 per package, max
      1,192) stat'ed synchronously at three workers — ~6 µs a file,
      the price of "a hit over intact outputs" meaning intact, and the
      one cost that scales with the repo rather than the task count
      (payload's 14,430 files, STATUS 2026-09-11, are the same lane).
      Refuted on the way, so nobody re-runs them: scoping the git
      enumeration to the run — strace shows both spawns already carry
      the loaded closure's 35 package directories as pathspecs (`git
status -uall` scoped is 19 ms here against 54 for the tree; the
      64-pathspec cap in `gitPathspecs` is what a `--all` run on a
      200-project tree exceeds, by design); and a cost in the exit
      path. Nothing to take without a design change to the proof.
154.  DONE (2026-09-11): `VX_TIMING=1` prints the stage table at the
      end of a `--dry` run too. Item 153's profile needed a 2.3 GB
      reinstall of refine because the table was silent under `--dry`,
      and the prepare stages (discovery, config load, the git
      enumeration) are exactly what a dry run exercises on a checkout
      with no install. Pinned in `tests/timing-dry.test.ts` (the
      table through `build graph` and `close` with the variable, absent
      without); `modules/timing.md` and `cli.md` say so.
155.  DONE (2026-09-12 — owner: "frozen should always be faster;
      the benchmarks page says otherwise"): it is a tie, and the page
      said why wrongly. Since the config-evaluation cache (2026-09-02)
      a plain warm run evaluates nothing for a provably pure config and
      serves the validated object from `cache.db` with no
      re-validation (`project-loader.ts`: "stored AFTER validation, so
      a hit needs none"); `--frozen` parses the 1.1 MB lock and
      re-validates all 1,000 entries, because the lock is hand-editable
      (`lockfile.ts`, deliberate). Frozen skips only the per-config
      identity stat and pays the parse back. Measured on the
      1,000-project bench, compiled binary, 12 interleaved reps: plain
      min 154 / median 177 ms, frozen 148 / 165; `load configs` 20–25
      ms plain against 6–10 (lock read) + 12–14 (load) frozen, with a
      temporary mark. The 2026-09-03 46-package row (83 vs 76, median
      of 1) is that tie under noise, not a regression. No code change:
      the validation is the boundary. `benchmarks.md` corrected in
      place — the frozen paragraph, and "Known headroom", which still
      said an evaluation cache had been rejected — and `--frozen`
      documented for what it buys: the guarantee, and eval-free runs
      for configs the purity gate cannot prove.
156.  REFUTED by measurement (2026-09-12 — owner: "prove it first"):
      trusting an unedited `vx-lock.json` to skip its per-entry
      validation. Three ways were on the table — a self-stamp written
      by `vx lock`, git cleanliness of the tracked lock (the
      enumeration already knows it, but a scoped run's pathspecs do not
      reach the root file), and pnpm's pattern, a validated-identity
      record in machine-local state. pnpm's was verified on a scratch
      workspace under pnpm 11.21: `node_modules/.pnpm-workspace-state-v1.json`
      holds `lastValidatedTimestamp` and the resolution settings; a
      `pnpm run` under `verify-deps-before-run` opens `pnpm-lock.yaml`
      zero times while every manifest is older than the stamp, once
      after a `touch` (same bytes: it re-checks the lock against the
      manifests' specifiers and re-stamps), and refuses with
      `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` after a specifier edit. For vx
      the same record would live in `cache.db` behind the stat memo
      `hashFile` already keeps. The ceiling was measured before
      building it: one probe binary from HEAD whose frozen path skips
      `validateProjectConfig` under an env var, three arms interleaved
      15 times on the 1,000-project bench — plain min 134 / median
      146 ms, `--frozen` 129 / 137, `--frozen` without validation 125
      / 134. Every trust mechanism can save only that step: 3–4 ms a
      run, ~2.5%, for a second staleness surface on a boundary check.
      Not built. What frozen keeps over plain, the identity stats, is
      the ~9 ms between the first two rows.
157.  DONE (2026-09-12 — owner: "devs will not know what to put in
      `exec.resources`, and it can change at any time; let the schedule
      history take past usage into account", then on the first cut:
      "the concept of resources should be only in history schedule —
      why should core know it"): reservations learned from history,
      and core knows no resources. Core keeps one seam, the `admit`
      stage: `VxPlugin.admit(task, ctx)` is asked at every local
      dispatch after the count gate with `ctx.running` (the tasks
      executing here, in dispatch order) and `ctx.concurrency`; `false`
      holds the task until something finishes. Synchronous; a throw is
      reported once and the plugin admits from then on; restore-tier
      hits and pooled tasks are never asked or counted; all answering
      plugins must admit; with none answering the dispatch loop is
      byte-identical to before (no running set, no closure). Removed
      from core in the same change: `exec.resources` and its
      validation, `ResourcesConfig`, `--memory` / `RunOptions.memory`,
      `TaskPlacement.resources`, the scheduler's two-axis packing, the
      footer's budgets, the `vx show` row, `orchestrator/resources.ts`
      (a breaking change, pre-alpha; a config declaring `resources` is
      refused as an unknown field, never silently re-keyed; no
      `CACHE_VERSION` bump — see the design note). `TaskHistory` now
      carries the usage maxima over the window (`maxPeakRssBytes`,
      `maxCpuParallelism`, successful executions only), and
      `@vzn/vx-schedule-history` turns them into reservations in the
      history read it already makes: the largest peak RSS × 1.25
      rounded up to 64 MB (omitted under a step), the most parallelism
      seen rounded to a core (omitted at one); `reservations` declares
      by hand and wins; `memory` (MB) names the budget a cgroup hides;
      its `admit` packs them, a task over a whole budget running alone.
      Pinned: the scheduler's admission (`scheduler.test.ts`:
      serialize / concurrent, same-tick visibility, backfill, solo,
      skip-safety, restore and pooled never asked, FIFO, no policy
      identical), the stage end to end (`plugin-pipeline.test.ts`: a
      veto serializes what a control overlaps, the context in order, a
      throwing policy reported once), the history maxima
      (`history.test.ts`), the estimator and the packing rule
      (`resource-estimates.test.ts`), and two ~200 MB tasks under
      `memory: 512` overlapping on the first run and serializing on the
      second (`schedule-history-e2e.test.ts`). Measured (compiled
      binaries, origin/main vs this, interleaved on the 1,000-project
      bench, one workspace per arm): warm no-op 24 reps min 135 / med
      144 ms both arms; `--force` (every task through the exec-tier
      dispatch) 6 reps min 1753 / med 1859 vs 1800 / 1846 — a tie
      inside the spread; without a policy the dispatch tracks nothing.
      Design note: `docs/design/resource-estimates-2026-09.md`. Step 2
      is item 158.
158.  DONE (2026-09-12): the producing execution's usage rides the
      artifact (step 2 of item 157). A fresh CI runner has no history,
      and that is where the budget bites. `cpuMs` and `peakRssBytes`
      join the artifact's sidecar (`.vx-meta.json`, an optional `exec`
      field), so every wire ships them verbatim and the
      `RemoteCacheLayer` seam does not move; save and ingest index them
      on the `entries` row from the artifact (`cpu_ms`,
      `peak_rss_bytes`; `SCHEMA_VERSION` v26, no `CACHE_VERSION` bump —
      the container is unchanged and an old artifact reads as before);
      a hit surfaces them as `storedCpuMs` / `storedPeakRssBytes` on its
      outcome, `--summarize` and the event stream (what the hit
      skipped, never what it spent, the `storedDurationMs` split); the
      history reader takes them from a hit row's entry with a
      primary-key join over hit rows only, so `@vzn/vx-schedule-history`
      has a reservation on the machine's next run. No "observed
      elsewhere" row: the entry is the record. The ingest side takes a
      foreign sidecar's numbers only as plain non-negative numbers.
      Pinned: pack → scan round trip and the boundary
      (`archive-security.test.ts`), the entry built from the artifact on
      save and ingest alike (`cache.test.ts`), a hit row's usage from
      its entry and a pruned entry contributing nothing
      (`history.test.ts`), and end to end through the stub remote
      layer: a `.vx`-wiped run restores from the remote, the hit carries
      the first run's peak RSS as `storedPeakRssBytes` and none as its
      own, and the history reader over the fresh cache reports it
      (`orchestrator-remote.test.ts`). Measured (compiled binaries,
      origin/main vs this, interleaved on the 1,000-project bench, one
      workspace per arm): warm no-op 12 reps min 134 / med 140 vs
      137 / 142 ms; `--force` 6 reps min 1840 / med 1862 vs 1760 /
      1792 — a tie inside the spread both ways (the hit path spreads two
      optional fields per entry; the save binds two more columns).
159.  DONE (2026-09-12): every Linux peak RSS was recorded 1024× too
      big. `resourceUsageToCpuRss` multiplied Bun's `maxRSS` by 1024 on
      Linux on the belief that Bun passes the kernel's kilobyte
      `ru_maxrss` through; Bun normalizes it to bytes on every platform
      (its typing says so, and a child that allocates 300 MB reports
      329,129,984). Found by measuring what a test shard would teach the
      dogfooded plugin: a 64 MB `bun test` read as 64 GB. The reach:
      telemetry (`vx.peak_rss_bytes`), `--summarize`, the run history
      and, since item 157, every reservation learned on Linux — over any
      budget, so a task with a recorded peak ran ALONE; CI never showed
      it because a runner has no history, and the plugin's own e2e
      passed for the wrong reason (two 200 MB tasks serialize under
      `memory: 512` either way; they still do with the true numbers,
      640 > 512). The only pin was a pure-function test that enshrined
      the assumption. Now `peakRssBytes = maxRSS` everywhere, and the
      pin allocates a known 200 MB in a child and reads the peak back
      within a bounded factor (`tests/runner.test.ts`): the old multiply
      fails it at 229 GB, a kilobyte value read as bytes would fail it
      at 200 KB. `docs/modules/runner.md` corrected; CLAUDE.md gains the
      rule. Not a stale-hit class: the number never fed a key.
160.  DONE (2026-09-12): the memory budget is what the process may use,
      not the host's RAM. `@vzn/vx-schedule-history` defaulted `memory`
      to `os.totalmem()`, which inside a cgroup-limited container is the
      host's total — this box says 15.7 GiB while its leaf cgroup allows
      13.3 GiB, and a CI job's docker executor or a Kubernetes runner is
      the same shape; the README told the user to pass `memory` there,
      which nobody does before the OOM killer says so. The plugin now
      reads the tightest limit on the path from this process's cgroup
      to the root — `memory.max` on v2 (`max` binds nothing),
      `memory.limit_in_bytes` on v1 (the page-counter sentinel binds
      nothing), an ancestor's limit binding too — and budgets
      `min(total, limit)`; `memory` still overrides. Linux only; a
      membership path outside the root is not walked; nothing here can
      throw. Pinned on fixture trees for both hierarchies, the ancestor
      case, the sentinel, absent files, the escape, and the live read of
      this machine (`tests/memory-limit.test.ts`, now core's
      `tests/cgroup.test.ts`, item 161). Alongside, the CPU-time unit
      got the same measured pin as the RSS one (item 159): a 500 ms
      spin reads back as CPU inside [50, 2000] ms — a bound only a
      unit slip (ms or ns read as µs) can leave; a loaded macOS runner
      gave 357 ms, which a 400 ms floor failed once.
161.  DONE (2026-09-12): the default worker count honours the cgroup
      CPU quota, and the cgroup walk has one implementation. Core's
      default was `navigator.hardwareConcurrency`, which inside a
      container is the HOST's core count — eight workers on a docker
      `--cpus=2` job, oversubscription by four, in exactly the CI
      shape item 160 found for memory. `util/cgroup.ts` now owns the
      walk from this process's cgroup to the root for both controllers:
      `machineParallelism()` is the cores capped by the tightest quota
      (`cpu.max` on v2, `cpu.cfs_quota_us` over `cpu.cfs_period_us` on
      v1, `-1` / `max` binding nothing, an ancestor binding too),
      rounded UP (a 1.5-core quota is two workers) and never below one;
      it is the default in `run()`, the placement preview and
      `--concurrency <n>%`. `machineMemoryBytes()` moved here from the
      plugin (item 160) and both are on the façade, so
      `@vzn/vx-schedule-history` imports the one walk instead of
      carrying its own. Pinned on fixture trees for both hierarchies
      (`tests/cgroup.test.ts`: the tightest level, `max` / `-1`, the
      fraction, the escape, the live read never above what the OS
      reports). This box has no CPU quota (`-1`, four cores), so the
      live differential is memory's; the CPU arm is fixture-proven.
162.  DONE (2026-09-12): the macOS descriptor tripwire
      (`bun-test-import-descriptors.test.ts`) read `after - before` as
      exactly 0 on Bun ≥ 1.4.1; the runner read -1 once, on a docs-only
      PR — a descriptor an earlier file left open closing between the
      two samples of a shared process. The claim is that imports pin
      nothing, so the pin now reads no growth (`<= 0`); a leak still
      reads positive.
163.  DONE (2026-09-12): `vx info` names `admit` and says what a run
      will use. A probe of the doctor after items 157–161 found two
      gaps: its seam list was a second copy of the capability list and
      did not know `admit` (the plugin read `(schedule)` alone), and
      nothing told a user in a container that the run had picked two
      workers or a 13 GB budget, or why. Two rows now: `workers`
      — `4 — the CPU count`, `2 — cgroup CPU quota 2 of 8 cores`,
      or `8 — vx.workspace.ts (4 cores)` — and `memory` —
      `13 GB usable — cgroup limit; the machine has 16 GB`, or the
      total — both in the JSON facts (`workers` with `count`,
      `source`, `cores`, `cpuQuota`; `memory` with `usableBytes`,
      `totalBytes`, `cgroupLimitBytes`); `vx run --help` says "the
      cores this process may use". Pinned: the row shapes (pure) and
      the live rows and facts in the info e2e.
164.  DONE (2026-09-12): one plugin hook list. Item 163's gap was a
      second copy of the seam list, and the loader kept a third (its
      ad-hoc plugin type and its `caps` array), the class "suspect a
      second copy of the rule" names. `PLUGIN_HOOKS` now lives beside
      the `Plugin` type in `config.ts`, in pipeline order, with a
      compile-time pin that the list and the type's keys agree both
      ways; the loader's function-hook check and its "at least one of"
      message, and the doctor's seam column, derive from it, so a stage
      added there is a stage everywhere. The message's order is the
      pipeline's now (`schema.md` and its drift pin follow).
165.  DONE (2026-09-12): the hook tables follow the list. Five hand
      tables tabulate the hooks — `architecture.md`, `modules/plugin.md`,
      the pipeline design note, and the site's plugin guide and
      extensibility flow — and two lacked `fingerprint`. Drift pins now
      hold them to `PLUGIN_HOOKS`: `tests/plugin-hooks-doc-drift.test.ts`
      in core for its three, and `tests/plugin-hooks-guide.test.ts` in
      `@vzn/vx-docs` for the site's two, reading the list off the façade
      (`PLUGIN_HOOKS` exported for that consumer). The lifecycle pair is
      prose in the stage tables and required in the hook tables; a
      control drops `admit` from a table and shows the extractor sees it.
166.  DONE (2026-09-12): the docs' "currently" copies of `CACHE_VERSION`
      and `SCHEMA_VERSION` are pinned to the constants. The sweep for a
      second copy found `modules/cache.md` still saying the index schema
      was v25, a morning after item 158 bumped it; caching.md (two
      lines), that sentence and cli.md's `vx info` sample now read the
      constants in their drift pins. CLAUDE.md's copy stays a rule — a
      core test may read only its own package.
167.  DONE (2026-09-12): the doctor's facts are an orchestrator module,
      and `vx mcp` answers them. `cli/info.ts` held the collector — the
      staged config load, the plugin seams, the cache versions and
      orphans, the worker and memory sources — behind the verb's
      renderer, so an agent that wanted "what is this workspace and
      what will a run use" had to shell out to `vx info --format json`
      and parse a CLI. `collectInfo(cwd, { cacheDir?, warn? })` and
      `InfoFacts` now live in `orchestrator/doctor.ts` and on the façade
      (the package-boundary snapshot widened by one name); the verb is
      the renderer over it. `@vzn/vx-mcp` gains `getWorkspaceInfo`,
      the sixth tool: the same collector over the command context's
      cache dir, so the tool and the verb cannot disagree. Pinned in
      the MCP suite (the facts over the wire: versions by shape, the
      fixture's one project, task and entry, the worker and memory
      bounds) and the stdio round trip's tool count; docs in
      `modules/doctor.md`, the package README and the site's MCP guide.
168.  DONE (2026-09-12): `vx last` shows what each executed task used.
      The runner has recorded every execution's peak RSS and CPU time
      since item 157, and `@vzn/vx-schedule-history` reserves from
      them, but no surface showed a developer the number — the JSON
      form carried it, the table did not. A task's row now ends
      `45 MB · 0.9× cpu` (peak RSS, CPU time over wall time); a hit
      spent nothing and shows nothing. Pinned end to end, the unit proven
      by its bound (a one-file task peaks between 1 MB and 1 GB — the
      kilobyte and the ×1024 readings both fall outside). Found on the
      way: cli.md still said `vx mcp` serves five tools; six, since
      item 167 — a second copy of the count, corrected. CI then
      reddened on a guard the diff does not touch: `Cache.key`'s
      scaling ratio read 34× against 30 on the shared runner (51× once
      under thirteen local shards, twice on main before min-of-3). The
      guard exposed a 1 ms window (one 100-file key) against a 10 ms
      one (one 1000-file key), so noise that lands per rep lands
      unequally. Refuted here as the cause: four CPU hogs (10–11×,
      three of three) and the twelve shards beside it (10.8–11.3×) —
      the runner's noise is not this box's. The guard now compares one
      1000-file key against ten 100-file keys, the same work per rep
      on both sides, ≤ 3× (quadratic reads 10×): 0.95–1.16 across ten
      probes in all three conditions.
169.  DONE (2026-09-12): `vx history` — the schedule-history plugin shows
      what it learned. The reservations are decided at dispatch and core
      holds no notion of them, so nothing showed a developer what the
      plugin would pack or why two tasks stopped overlapping; the design
      note allows showing an observed number and forbids writing one.
      The plugin now adds a verb on the `commands` seam: per task, runs
      in the window, p50, the largest peak RSS, the CPU parallelism and
      the reservation (a declared one marked), over the budgets it packs
      into — the default worker count and the memory option or what the
      process may use; `--format json` for scripts. It resolves the
      workspace as a run does (`loadResolvedProjects`) and reads the
      same history the hook reads. Pinned end to end through the real
      dispatcher: a 200 MB task's row and reservation, the estimator's
      rule over every shown peak, a declared reservation, the pretty
      rows, an unknown flag. Docs: the package README, cli.md's plugin
      commands. Found on the way, by the pin's own probe: `true` read
      a 44 MB peak through vx and 15–18 MB from a bare bun script,
      while the shell's own `VmHWM` is 1.9 MB. Linux folds the
      parent's RSS high-water mark into a child's `ru_maxrss` at exec
      (a forked child starts with its parent's pages), so a task
      lighter than vx itself reads vx's footprint: 300 MB allocated in
      the parent and `true` reads 328 MB, proven both ways. On a large
      workspace every light task would reserve vx's own RSS and the
      plugin would pack phantoms. Item 170 fixes the recording; the
      pin here claims the estimator's rule over the shown peak, not
      what a trivial task shows.
170.  DONE (2026-09-12): a task lighter than vx itself records no peak.
      The runner reads its own RSS high-water mark after the child
      exits (`VmHWM` from `/proc/self/status` on Linux — the mark is
      monotonic, so one read after covers the task's span; the current
      RSS elsewhere) and reports `peakRssBytes` only above it; `cpuMs`
      is the child's own either way. Under the mark the peak is
      unknown, bounded by vx's footprint, and the plugin reserves
      nothing for it — what such a task needs. Differential: from a
      process holding 300 MB, `true` reports no peak (328 MB without
      the floor) and a 600 MB task reports its own; the light-task pins
      that expected a number now expect none, and the three fixtures
      whose usage round trip needs a number (`vx last`, the remote
      hit's stored usage, `vx history`) hold 150 MB. The test processes
      that spawn them peak at 51–75 MB (measured), so the fixtures
      out-weigh them with room. Docs: runner.md, cli.md, execute-task.md,
      the design note, the plugin README.
171.  DONE (2026-09-12): the run says when a policy held a task. The
      plugin's `vx history` says what it will reserve; nothing said
      what that cost a run — two tasks that stopped overlapping looked
      like a slower machine. The scheduler now times a task from the first
      refusal it meets with a worker free to its dispatch and puts the
      wait on its outcome as `admissionHeldMs`; `--summarize` rows and
      the event stream carry it, and the footer's `info` row sums it
      (`admit held 3 tasks 4.2s`). Zero-cost without a policy: no map,
      no clock read, no field. Pinned: the serialized pair carries the
      hold on the held task only and a policy-less run on neither
      (scheduler), the vetoing plugin's second task through `run()`
      and the control run's absence (plugin-pipeline), the footer line
      (summary). Docs: scheduler.md, cli.md, the design note.
172.  DONE (2026-09-12): the release tree is assembled on every gate.
      v0.0.19's `npm publish` died at its first step — `build-npm.ts`
      copied `packages/vx/plugins`, the root shim directory that left
      with the last plugin subpath two days earlier, and the darwin job
      exited on `ENOENT ... /packages/vx/plugins` before a single
      package was published (nothing reached the registry; the release
      assets attached fine, they are a different workflow). The script
      ran nowhere but the release, so nothing could catch the drift.
      Two changes: the copy list is DERIVED from the core manifest's
      exports map (`coreEntries` — `index.ts`, `src`, and the top
      directory of every non-"." subpath, which is the directory twin
      the compiled binary resolves by), and it is a hard error, named,
      if a path it would ship does not exist; and the main-package
      assembly is `emitMainPackage`, exported, so the gate builds the
      real `@vzn/vx` tree into a temp dir without the four
      cross-compiled binaries. `tests/build-npm.unsafe.test.ts` (unsafe:
      the tree carries the repo-root README and LICENSE) pins that every
      entry in the emitted `files` exists, that the launcher `bin`
      points at a shipped file, and that each exports subpath has its
      twin; differential — restoring `plugins` to the list fails it with
      the named error. The same hardcoded name in
      `package-entry-shims.unsafe.test.ts` is now derived from the
      subpath too. Not re-runnable for v0.0.19: that tag carries the
      broken script, so the next release (v0.0.20) is what publishes.
173.  DONE (2026-09-12, assessment — the real-repo dogfood the arc
      pointed at): TanStack/router, 307 projects, installed (pnpm,
      72 s, 2.1 GB) with the plugin declared. A cold run of every
      `build` executed 296 tasks in 421 s at four workers; `vx history`
      then showed every build's peak (380 MB–1.0 GB) and the
      reservation it packs (512–1344 MB), three rows with no peak —
      two tasks under vx's own footprint, one failure — as designed;
      `vx last` ended each row with its usage. The one failure is the
      repo's: the solid `start-basic-static` example prerenders by
      fetching an external API, refused by this egress. Under the
      13.6 GB budget nothing was held and a forced second run tied
      the first (403 s); under `memory: 1024` on a four-package subset
      (13 tasks with deps) the footer read `admit held 8 tasks 39.35s`
      and the rows named each hold — the feature reads right on real
      data. One observation to carry: CPU parallelism is a reading of
      contention. The same builds read 0.9–1.0× beside three others
      and 1.9–2.3× alone under the tight budget, the plugin keeps the
      maximum, so each then reserved 2 cores. On that 13-task graph
      an A/B (count-only vs learned, interleaved twice) tied — 40.0 /
      38.6 s vs 38.9 / 41.0 s — with no hold fired, since the graph
      never had three tasks ready at once; whether 2-wide packing
      loses on a wide graph (single-threaded phases idle the other
      cores) is Next 18, unmeasured. Install and outputs cleaned; the
      configs and the bench logs stay.
174.  DONE (2026-09-13): every Linux CI job that runs a vx task installs
      the sandbox runtime, and the class is pinned. v0.0.20's publish
      stopped one step past 172's fix: `npm.yml`'s ubuntu job never
      installed bubblewrap / socat / ripgrep, so both
      `build.bun.linux-*` tasks failed in 0 ms — "sandbox not available:
      ripgrep (rg) not found; bubblewrap (bwrap) not installed; socat
      not installed" — and `@vzn/vx` never reached the registry. The
      macOS job runs first and had already published
      `@vzn/vx-darwin-x64` and `-arm64` at 0.0.20, so npm holds the two
      darwin packages at 0.0.20 and `@vzn/vx` at 0.0.18; the release
      assets are fine (`release.yml` installs the deps, and its four
      binaries and signatures attached). The gap was old — `npm.yml`
      gained the cross-compile WARM step when the build tasks became
      sandboxed and never the deps — and invisible: v0.0.18 predates
      the sandboxed build, and v0.0.19 died earlier, in the darwin job.
      `npm.yml`'s publish job and `release.yml`'s assets job now use
      `.github/actions/vx-runner`, the same composite step `ci.yml` and
      `docs.yml` already used (deps, the AppArmor userns lift, the
      bwrap probe, the warm), so the dependency list lives in ONE file.
      `tests/workflow-runner.unsafe.test.ts` pins the class off the
      workflow YAML: the five Linux jobs that run a vx task are named
      exactly (a vacuous pin is the failure mode here), each must use
      the action, and the action must still install the binaries the
      probe looks for; differential — dropping the `uses:` from
      `npm.yml` fails it naming `npm.yml#publish`. `npm.yml` also takes
      a `ref` input now: a dispatch runs the fixed workflow from main
      against the code a tag names, which is the only way to finish a
      release whose publish died on a workflow bug (re-running the
      failed run replays the file pinned to the tag). Docs: cli.md's
      Releasing section. The gate could not run in this container (root
      in a container, so the seccomp helper cannot nest a user
      namespace: 41 sandboxed tasks fail); lint, the format scan and
      `bun test` stood in — 2877 pass, the two peak-RSS readings that
      fail here fail on main's tree too and are green on the runners.
      Outcome (2026-09-13, 16:47Z): v0.0.21 was released on this
      commit instead of a dispatch, and its `npm publish` run succeeded
      end to end — the registry holds `@vzn/vx` and all four platform
      packages at 0.0.21, `latest` — so the set is complete without
      re-running v0.0.20 (verified 2026-09-15, `npm view`). Reviewed
      2026-09-15 with 172: both landed green on main's CI; 174 was
      pushed straight to main without a PR, the one deviation from
      the gate-push-PR-merge workflow.
175.  DONE (2026-09-15): the CLI's stdout reaches a pipe whole. Found
      by Next 18's harness: `vx history --format json` on the
      307-project router clone, piped into a parser, was cut mid-string
      at 128 KiB. Bun 1.4.2 drops what a pipe has not yet taken when
      `process.exit` follows a large write — measured in isolation, 300
      KB written then exit delivered 64 KiB (128 KiB after a tick),
      while ending stdout and exiting in its callback delivered all of
      it, and still exited under a reader that closed early, a null
      sink and an empty stdout. `bin.ts` does that now; every verb
      that writes JSON (`show`, `last`, `why`, `info`, `history`) was
      exposed, since each returns its code and the entry point exited
      at once. Pinned by spawning the real entry point: a project's
      JSON from `vx show` with a 2 MiB description, read by a
      reader that starts 500 ms late (a reader that drains at once
      takes everything before the exit and proves nothing) — fails
      three of three on the old path (1.1 MiB, 1.1 MiB, 219 KiB
      received) and passes with the fix. Rule in CLAUDE.md.
176.  DONE (2026-09-15, Next 18 measured): the schedule-history plugin
      no longer learns cores. On the router clone, a solo history first
      (92 react-example builds at one worker, 241 s; CPU parallelism
      p10 / p50 / p90 1.61 / 1.92 / 2.23×), then the arms at four
      workers with `--force`, interleaved: count-only 176 / 132 / 133 /
      134 s (the 176 a first cold rep), learned 160 / 161 / 171 s with
      85 of 92 tasks held (`admit held 85 tasks 4783s`, task-seconds).
      Min-of-N 132 against 160: 21% longer. The reading is a function
      of contention — the same builds read 0.9–1.0× beside three others
      in item 173 — the estimator kept the window's maximum, and every
      build then reserved two cores, so a four-core box packed two wide
      and idled cores through each build's single-threaded phases.
      Memory has no such feedback (a peak is a peak wherever it ran) and
      stays learned; `cpus` stays declarable through `reservations` for
      a task that must run alone. Pins: the estimator learns no cores
      whatever the parallelism seen, a declared `cpus` still packs, the
      `vx history` row carries none. Docs: the plugin README, the design
      note's Rejected list. Install, outputs and the pnpm store cleaned;
      the configs and bench logs stay.
177.  DONE (2026-09-15): `vx mcp`'s `getRunHistory` names the usage its
      rows carry. A probe of the surfaces after the arc (`vx info`, its
      JSON, `getWorkspaceInfo`, `vx history` on a workspace declaring
      both plugins) read right everywhere; the one drift was in words:
      the history rows have carried `maxPeakRssBytes` and
      `maxCpuParallelism` since item 157 and the tool description, the
      package README and the site's MCP guide never said so. Named now,
      and the stdio round trip pins them on the wire — CPU parallelism
      always on record, the peak absent for a task lighter than vx
      itself.
178.  DONE (2026-09-15): the footer's hold line says it is a sum. On
      router it read `admit held 85 tasks 4783s` beside `time 160s` —
      the waits summed, task-seconds, which nothing said. It reads
      `admit held 85 tasks, 4783s in all` now; the per-task waits stay
      on the `--summarize` rows. Pin and docs follow.
179.  DONE (2026-09-15, Next 6 duty): the day's diff A/B'd on the warm
      path. Item 175 put an `end` on stdout before every exit, which is
      the tail of every run, so compiled binaries of main before it
      (2f6496c) and after item 178 (3901e12) ran interleaved on the
      1,000-project bench, one workspace per arm: warm no-op 12 reps
      min 180 / med 187 ms before vs 182 / 187 after; `--force` 6 reps
      min 2506 / med 2526 vs 2494 / 2531 — a tie inside the spread. The
      absolute figures sit 35–40% above the 2026-09-12 morning baseline
      (133 / 139 and 1789 / 1846) on both arms alike, which is the
      box's evening, not the code's, as 14b found the other way round;
      the per-arm comparison is what the duty asks and it reads even.
180.  DONE (2026-09-15): the plugins guide shows an `admit` policy. Its
      `admit` paragraph was prose only, and still said the reference
      plugin reserves CPU parallelism — retired by item 176. The
      paragraph reads memory with headroom and declared cores now, and
      carries the smallest useful policy: the e2e suites that share one
      database run one at a time while everything else keeps the worker
      count — eleven lines, type-checked by the guide's snippet pin
      like every other block — and names how the run reports a hold.
181.  DONE (2026-09-15): three first-run surfaces read straight. A
      fresh two-package workspace was walked from `vx init` through
      run, why, last, info and watch, and three things read wrong.
      `vx last --list` showed a watch cycle as
      `$ /…/src/bin.ts watch build --all` beside `$ vx run build
--all`: `watchCmd` never set the invocation `command`, so run()'s
      process.argv fallback recorded the bin's path (pinned in the
      watch-loop suite by `vx last --list` during a watch). `vx why`
      said `cache-hit · cache hit · key …` for a hit: the status names
      the hit and its tier, so the word now follows executed runs only
      (`success · executed`, as documented; a third-run pin in
      why.test.ts fails on the old line). `vx info`'s `runs (24h)`
      counted task runs — three invocations of two tasks read 6 —
      while `vx last` calls an invocation a run; the row is `task runs
(24h)` and cli.md says what it counts and where the invocation
      count lives (`vx last --list`). The JSON field stays `runs24h`.
      Refuted on the way: the migrated configs, the TODO's cache-block
      guidance (followed literally, the second run hit), `vx why`'s
      first-run line, `vx info`'s worker and memory rows, and watch's
      recovery from a broken package.json all read right.
182.  DONE (2026-09-15): the uncached upstream's moving key is pinned
      and said. The second walk (error paths: a typo'd task, an
      unknown filter, a failing command, `why` on an uncached task —
      all read right) found a cached dependent of an uncached upstream
      missing twice before it hit. The cause is by design, not a
      defect: a task with no `cache` block folds `**/*` of its project
      into the key its dependents fold, its own outputs included since
      it declared none, so writing an un-ignored file moves its key
      after the first run (gitignored outputs keep it still — the
      control). Not changed: excluding untracked files would hide a new
      source from the key (a stale hit downstream, the worst class),
      and the task's outputs are unknown by definition. Changed: the
      rule is in caching.md § key derivation; `vx why`'s detail on an
      uncached task said the verdict twice and now says what moves its
      key; `vx init`'s TODO says every file here folds into dependents'
      keys until the block exists; `tests/uncached-upstream-key.test.ts`
      pins the double miss and the gitignored control. A third walk over
      the planning and maintenance verbs (`--dry` before and after a run,
      `--graph`, `show --format json`, `lock`, `cache --help`, a wrong
      `cache` subcommand, `run --help`) found nothing off.
183.  DONE (2026-09-15): the `vx info` sample in cli.md is the verb's
      output. It padded its first five rows wider than the rest and
      appended a `git config core.fsmonitor true` hint to the status
      cache row that the renderer never prints (the bullet below the
      sample is where the advice lives). Rewritten row for row in the
      verb's format. `vx mcp`'s `getCacheStats` description now says
      its counts are task runs, as item 181's row does. The versions
      pin on the sample (`cli-doc-drift.test.ts`) assumed one space
      after the label and now tolerates the padding.
184.  DONE (2026-09-16): a typo'd verb is one line. A fourth walk
      (`--version`, an unknown verb, `last` and `why` before any run,
      `run` without `--all` from the root, `upgrade` from a source
      checkout) read right except the unknown verb, which printed its
      near-miss hint and then the whole help — a hundred-odd lines past
      the line that mattered — while every verb's own unknown flag or
      subcommand is one line with a pointer at that verb's `--help`.
      The verb typo is now the same shape, pointing at `vx help`; the
      two pins assert the pointer and the absence of the help text.
185.  DONE (2026-09-16): the classes behind items 181, 182 and 184
      grepped, per the rule. Callers of the orchestrator's `run()`: only
      `vx run` and `vx watch`, both recording their command now (the
      MCP server drives no runs); a verdict and a detail that repeat
      each other: none left in `metrics.ts`; a small error that prints
      the whole help: only the two `--help` paths, on purpose. One
      stale claim found on the way: `telemetry.ts` still described
      bin.ts's exit as `process.exit(await run(...))`, the form item
      175 replaced; the comment's argument (a never-settling flush
      would exit 0) holds either way and now names the current form.
186.  DONE (2026-09-16, refutation): a fifth walk, the CI persona,
      found nothing off. On a fresh two-package workspace: `vx lock`,
      `lock --check` clean and after a config edit (names the file,
      exits 1), `run --frozen` taking the lock over a live edit (as
      documented — pair it with `lock --check`), `--affected=HEAD~1`
      selecting the changed project only (deliberate, cli.md says so
      in bold and gives `--filter '...[main]'` for dependents;
      `design/affected-config-imports-2026-08.md` § Rejected), the
      `--summarize` file's shape, and `--output-logs errors-only`
      framing only the failure. Five walks since 14d found four
      items (181, 182, 184, and 183's sample) and then nothing; the
      next probe should change persona or surface, not repeat these.
187.  DONE (2026-09-16): the generated `vx-preset.ts` names the tool
      the configs name. A sixth walk, the Turbo adopter — the migrate
      CLI's `--dry` and its write, `run build` twice, `test`, `lint`,
      `show`, `info` — read right (the mapping, the one TODO on the
      persistent task, the hits) except the preset's header, which
      said `vx migrate`, a verb that does not exist (item 184's
      one-liner is what typing it gets), while every config said
      `vx-migrate`. One name now, pinned.
188.  DONE (2026-09-16): `vx lock` names what it cannot freeze. A
      seventh walk, a Turbo repo run unchanged under `turbo()` (show
      marking every project `from plugins`, two builds, test, lint,
      info's plugins row, why, a task's resolved config) read right,
      except `vx lock`, which wrote an empty lock and reported zero
      project configs locked, and `--check` then reported the lock up
      to date over zero projects — an audit of nothing that read like
      one. Both lines now count the projects without a vx.config and
      say their tasks are never frozen; cli.md § vx lock carries the
      rule; the pin holds both arms (no note when every project is
      configured).
189.  DONE (2026-09-16): the Nx migration's cascade TODOs say what vx
      folds. An eighth walk, the Nx adopter (a two-node project graph
      with run-script and run-commands targets: `--dry`, the write,
      two builds, test, lint, show, info) read right except the TODO
      written for a `^production` input and for
      `dependentTasksOutputFiles`, which said vx folds upstream
      OUTPUTS into the cache key — principle 5's reverse (the cascade
      folds each dependency's key, its inputs, never its outputs). Both
      texts now say so; pinned on the Nx fixture's `^production`.
190.  DONE (2026-09-16, refutation): the plugin author's walk found
      nothing off. A local package declaring a `key` part and two
      `commands` verbs, wired by path into `vx.workspace.ts`: `info`
      names the package and both seams; `help` lists the verbs with
      their owner; a verb gets its argv (`--help` included — the verb
      owns it); `why` names the plugin part when its value moves
      (`changed plugin @dx/hello/node-major`, digests, per 8g); a key
      value that is not a string is refused naming plugin, hook, key
      and task; completions carry the verbs. A verb that throws a
      plain Error prints `vx: Error: …` and its stack — deliberate and
      pinned (the control in plugin-commands.test.ts: a plugin's own
      bug is debuggable, its first frame is the plugin's file; a
      UserError prints its message only).
191.  DONE (2026-09-16): `whyDidThisRerun` answers for the latest run
      when no `runId` is given. The tenth walk, an agent reading the
      MCP server over the wire (initialize, tools/list, one call): the six
      descriptions read right except two things. The tool demanded a
      `runId` an agent has no way to know without a history call
      first, while `vx why` defaults to the task's latest run — the
      CLI's lookup moved into the orchestrator as `latestRunId` (one
      query, exported by the façade, the CLI on it too) and the tool
      defaults through it, naming the task when it has no runs; the
      schema says so, `runId` stays a string when given. And
      `getWorkspaceInfo`'s description still said "runs and hits"
      where item 181 made the row task runs — it and the MCP guide's
      `getCacheStats` row say task runs now. The tool suite pins the
      default equal to the explicit latest id and the no-runs refusal;
      the façade pin lists the new export.
192.  DONE (2026-09-16): the RSS floor has slack. PR #359's Linux job
      failed in item 170's pin — `true` after a 300 MB hold read a
      376 MB peak against a floor a few pages lower — on a diff that
      touched nothing near the runner, after twelve green runs of the
      same pin tonight. A light child's `ru_maxrss` is the parent's
      footprint at exec, so it sits ON the floor by construction, and
      the kernel's per-thread RSS counters lag by up to 64 pages
      between syncs: an exact `>` is a coin flip on jitter. A child
      now counts as its own only more than `RSS_FLOOR_SLACK_BYTES`
      (4 MiB, above any accounting jitter, below the 64 MB reservation
      step) above the floor; the unit pin sits on that edge, the
      measured pin is unchanged. Not a flake dismissed: a test on a
      knife edge, moved off it.
193.  DONE (2026-09-16): `@astrojs/starlight` 0.42.0 → 0.42.1, the one
      dependency that moved since item 92 (`bun outdated`, six days
      on); the site built and its link check passed in the gate. The
      built site was also read once for tonight's doc changes: the
      `vx info` sample and the caching paragraph render.

194.  DONE (2026-09-16, housekeeping this file asks for): items 105–144
      moved whole to `docs/history/2026-09-improvement-loop-105-144.md`.
      The loop had grown to 89 items and STATUS to 2,657 lines, past
      the forty-item rule above by two batches; the cut leaves items
      145 onward (the sandbox-era pins, the Nx round's tail, the
      resource and MCP work) where a fresh session reads them first.
      Nothing else changed: the two earlier history files gain the
      pointer, `doc-references` already skips `history/`, and the site
      importer never read STATUS.
195.  DONE (2026-09-16, the same housekeeping, § Next): the Next list
      was 540 lines, of which the open items (1, 2, 16) and the current
      handoff (14g) were 80. The rest was record: Next 6's dated
      closing figures and refutations, Next 7's four closed follow-ups,
      Next 8's measurements, and six superseded handoffs (14–14f). All
      of it moved whole to `docs/history/2026-09-status-next-log.md`;
      what stays under 6, 7, 8 and 14 is the standing duty or the
      still-open note with a pointer. Numbering is kept, since loop
      items cite "Next 15" and "14d" by name.
196.  DONE (2026-09-16, the suite's wall time): nine test files had no
      row in `tests/shard-weights.json` (each dealt at the median), so
      the twelve shards were re-weighed from JUnit, four at a time as
      the gate runs them. The nine were 5 ms to 1.1 s — not the
      problem. The problem was `tests/watch-loop.test.ts`: the table
      said 6.2 s (2026-09-10, three cases), the run said 24.4 s (nine
      cases, each a serial chain of settle windows), and one file
      cannot be dealt — its shard ran 32.7 s against 8–12 s for the
      other eleven, 52 s for the run. The cases share only a per-case
      workspace, so the fixture and markers moved to
      `tests/helpers/watch-loop.ts` and the file went three ways:
      `watch-loop` (the edit-cycle claims M8 and L5, 6.5 s),
      `watch-loop-members` (the watched set, 7.4 s) and
      `watch-loop-uncached` (undeclared outputs, 10.5 s); same 32
      assertions. Re-weighed after the split: every shard 9.7–13.6 s,
      the run 35 s. The partition pin failed on the interim table
      (24,420 against a 13,355 ceiling) and passes on the refreshed
      one — the 1.25× law fires when the deal is wrong, but only once
      the table tells the truth: a file that grows past its row is
      invisible until the next `--weigh`. Re-weigh whenever a suite
      gains timed cases. CI's first run of the new deal (wall 116.8 →
      93.8 s, the longest task 45.6 → 26.7 s) failed one pin the deal
      had been hiding: `runner.test.ts`'s "reads a known allocation
      back as bytes" allocated a fixed 200 MB and expected a peak, but
      `bun test` runs a shard's files in ONE process whose RSS mark is
      whatever the files before it left (monotonic), and the floor
      withholds a child's peak under the parent's mark (item 170) —
      shard 5 now ran `scale-graph` and `artifact-roundtrip` first, the
      mark passed 200 MB, and the child read as no peak at all. The pin
      sizes its child 200 MB above the parent's own mark now; the
      differential is a 256 MB `--preload` hold (old pin fails as CI
      did, new pin passes). A pin that depends on which files ran
      before it in the same process is a deal-shaped knife edge; the
      order comment it carried ("the 200 MB pin must come first")
      named the dependency and still trusted the alphabet. A second
      deal-shaped edge on the third CI run (#366): `output-dirs`'s cap
      case makes 8,193 directories and walks them — 3 s for the whole
      file here, 7.7 s for the case on a loaded runner under four
      shards — against bun's 5 s default; bounded at 30 s, as
      `affected.test.ts` bounds its own spawn-heavy case (a bound that
      matches the work still catches a hang).
197.  DONE (2026-09-16, the next long pole in CI): with the shards
      dealt, `@vzn/vx-reapi#test` was the longest task (26.7 s), and
      15 s of it was one case waiting out the control-plane deadline
      cap on a wedged socket to prove `min(callTimeoutMs, 15 000)`. The
      derivation is pinned on the instance now — `ReapiClient` exposes
      `metaTimeoutMs`, the cap is `META_TIMEOUT_CAP_MS` — with no wait:
      600 s in reads 15 s, 800 ms reads 800 ms, an explicit 700 ms is
      taken as given; the two short cases around it (explicit 700 ms,
      derived 800 ms) still prove the wire honours the deadline in
      force. Mutation checked: with the cap removed from the
      constructor the pin fails. The suite here: 27 → 11 s, 88 pass, 33
      skip (the live-service cases), and CI's plugin job loses the same
      15 s. Left as they are: `wedged`'s other waits (0.7–2.1 s each)
      are the deadlines under test.
198.  DONE (2026-09-16, the last of the housekeeping): § In flight's
      four closed sandbox-arc items and the v0.0.18 release record
      moved to `docs/history/2026-09-status-next-log.md` too; what
      stays is In-flight 5 (macOS), the release facts as of 0.0.21, and
      the launch checklist's owner steps with the stale "installs
      v0.0.18" sentence corrected.
199.  DONE (2026-09-16, the CI persona's first real failure): `vx run
build --affected` in the two clone shapes CI produces. A
      single-branch clone whose `origin/HEAD` is the branch under test
      resolved the default base to that branch — HEAD itself — and
      printed `nothing affected since origin/feat`, exit 0: a job
      configured that way runs nothing and goes green. A depth-1
      checkout with no `origin/HEAD` fell back to `HEAD~1` and failed
      with `git ref "HEAD~1" did not resolve`, a ref nobody typed. Now:
      the empty note names a base that IS HEAD (`refIsHead`, a spawn on
      the empty path only) and the two bases you probably meant
      (`--affected=origin/main`, `--affected=HEAD~1`); the fallback
      checks that `HEAD~1` exists and otherwise says `--affected has no
base here … a shallow clone? Fetch history (actions/checkout:
fetch-depth: 0) or name the base`. Pinned three ways in
      `tests/affected-base-notes.test.ts` (both shapes plus the control:
      a real base that selects nothing keeps the plain note) and in the
      `defaultAffectedBase` / `refIsHead` units; `docs/cli.md` and the
      site's CI guide say what vx says. Explicit refs are untouched:
      `--affected=origin/main` in a single-branch clone still says the
      ref did not resolve, which is true and names the fix. The site's
      own CI recipe had the first shape: its base fell back to
      `origin/main` on a push to main — HEAD itself — so the push job
      ran nothing and went green; on a push it diffs against
      `github.event.before` now, with the force-push caveat written
      down.
200.  DONE (2026-09-16, the CI persona, second gap): the site's CI guide
      never named `@vzn/vx-github`, the plugin that writes the job
      summary and the PR check run. A section shows the one-line
      declaration, the `checks: write` permission and the no-token
      behaviour, and points at the README for the rest.
201.  DONE (2026-09-16, a claim corrected in place): item 198's
      "Releases" paragraph said `npm.yml` "uses a scope-wide
      `NPM_TOKEN` instead if one is set", repeating the workflow's own
      header comment; the file reads no secret and no step sets a
      token, so a publish through it is the OIDC exchange or nothing,
      and 0.0.21 having published through it means the trusted
      publishers are configured — launch-checklist 1 is done bar
      deleting a secret nothing reads. The header comment says what
      the steps do now.
202.  DONE (2026-09-16, the maintainer's walk through `.github/`):
      `.github/actions/vx-agent` was the vx-cloud distribution agent's
      composite action — "joins a serve's session pool, executes
      assigned tasks" — from the product the 2026-09-02 direction
      removed; nothing referenced it and its last touch was 2026-09-03.
      Deleted. The one other live mention, a comment in
      `tests/config-eval.test.ts` citing the agent's idle-timeout flag
      as the project's zero-means-never analogy, cites the status
      line's floor instead. The design docs under `docs/design/` keep
      their dated mentions as the record they are.
203.  DONE (2026-09-16, the root-in-a-container persona): a task
      declaring `exec.sandbox` on this box fails with a precise line
      (the runtime's seccomp helper cannot create its nested user
      namespace as root inside a container; run as non-root or set
      `sandbox.weakerWhenNested`), but `vx info` said nothing about the
      sandbox at all, so the first sign was a failed run. The doctor
      has a `sandbox` fact now — the runtime probe's verdict (one
      sandboxed `true`, memoized, the Linux runtime reset afterwards so
      its proxy sockets do not hold a standalone process open) and how
      many loaded tasks declare a sandbox — rendered as one row,
      "available" with the declared count or "unavailable" with the
      probe's reason and the count that will fail; `--format json` and
      the MCP's `getWorkspaceInfo` carry it as data. Pinned in
      `show-info.test.ts` (either verdict, the fixture's zero count) and
      documented in `docs/cli.md` § vx info. CI's first run added a
      rule: inside the sandboxed test shard the runtime cannot listen on
      its mux socket, and the raw error quoted a path named after the
      process id, so two `vx info` runs differed by one number and the
      `vx stats` byte-identical alias pin failed — the doctor's text is
      pasted into bug reports and compared between invocations, so its
      reason drops the pid (`stableSandboxReason`, pinned with a
      control). No other pin compares two invocations byte for byte.
204.  DONE (2026-09-16, the same persona, one step further): the docs'
      advice under that verdict — run as a non-root user — was taken
      on this box (a `probe` user, bun copied where it can read it):
      a sandboxed task runs and `vx info` reads `sandbox: available`,
      so the reason line's first remedy holds where it is given. The
      probe's scratch workspace also had a config error, and the row
      read "0 tasks declare exec.sandbox" beside a project declaring
      one: when the shared load throws, the doctor falls back to a
      per-config count that tallied tasks but not sandboxes. The
      fallback counts both now, by the rule the docs already state (a
      config that will not load counts as zero, the rest count).
      Pinned in `show-info.test.ts`: a broken config next to a
      sandboxed project reads 5 tasks and 1 declared, with the
      whole-workspace control at the same numbers; fails without the
      fix (declared 0).
205.  DONE (2026-09-16, the gate as CI runs it, on this box): until now
      the sandbox suites ran on CI alone — the container is root, the
      runtime refuses a nested user namespace, and the local gate runs
      the tasks directly. As an unprivileged user the box hosts the
      whole thing: `vx run ci --all` with `VX_REQUIRE_SANDBOX=1` on a
      cold, user-owned copy of the repo, every shard sandboxed, 44 of
      44 in 99 s; the unsafe set 78 pass, 0 fail, 1 darwin-only skip
      (the nested-seatbelt group), `sandbox-runtime` 49 of 49. Recipe:
      a user (`probe`), a COPY of bun under a world-readable path that
      is on PATH under the name `bun` (fixtures run `bun serve.ts`; a
      differently named copy exits 127 inside the sandbox), `HOME` set,
      `cp -a` the repo and drop its `.vx`, `chown` the copy. Two traps,
      each a real failure before it was understood: (1) `bun --bun`
      links `node` to itself under `/tmp/bun-node-<build>/`, mode 0700,
      owned by whoever ran first — a second user gets no shim and no
      word of it, so `bun --bun astro build` ran the PATH's Node 20 and
      astro refused it; remove root's directory before the run. (2) A
      root-owned `dist/` left in the copy by a root control run made the
      output clean an "internal error" — item 206. The session's manual
      gate runs the unsafe step this way now; the user and the bun copy
      are box-only and die with the container, the recipe is here.
206.  DONE (2026-09-16, from 205's second trap): a declared output the
      process cannot remove (a `dist/` another user wrote, a read-only
      checkout) surfaced as `[vx] internal error in @vzn/vx-docs#build:
EACCES: permission denied, rm '…/dist/_astro/array.js'` — the
      scheduler's label for any error that is not a `UserError`, which
      sends the reader to file a bug against a permission bit. Both
      clean paths (`cleanOutputs`, `cleanWorkspaceOutputs`) raise a
      `UserError` now: `cannot remove declared output dist/a.js: EACCES
— vx clears a task's declared outputs before it runs and before a
restore; make the path removable by this user, or stop declaring
it as an output`. Pinned in `inputs.test.ts` on a 0o500 `dist/`,
      skipped as root (root removes anything; CI's runner is not root)
      and proven both ways here as the `probe` user; `docs/caching.md`
      names the failure beside the clean contract. The clean runs on
      the hit-restore path, so Next 6 on this head: 1,000 projects 244
      ms warm / 700 restore / 2,570 cold (medians of 5; the morning's
      237 / 744 / 2,520) — a `.catch` per removed file is inside jitter.
207.  DONE (2026-09-16, the class of 206 grepped as the `probe` user):
      the task path touches the tree three times — clean, restore,
      save — and each was asked what it says to a tree it may not
      write. Save was already right: an output the process cannot read
      warns `cache save failed: EACCES …` and the task succeeds
      unsaved. Restore was not: a hit into an empty `dist/` this user
      cannot write into read "internal error" with a
      `CorruptArtifactError` (not a readable archive), the artifact
      intact. The extract's catch already names what is on disk for
      the shape codes (`EISDIR`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`);
      `EACCES`, `EPERM` and `EROFS` join it as a `UserError`, "restore
      of <hash> into <dir> could not write its outputs (EACCES: …)".
      Pinned in `cache.test.ts` on a 0o500 `dist/` (skipped as root,
      proven both ways as `probe`); `docs/caching.md` names it beside
      the clean's line. Refuted on the way: `chmod 500 .vx` alone
      proves nothing — the cache's files sit in subdirectories already
      created, so the run saved as before; an unwritable cache
      directory is a separate probe, not taken.
208.  DONE (2026-09-16, that probe taken, as `probe` with the whole
      `.vx` read-only): every task failed at 0 ms, warm hits included,
      as an internal error carrying SQLite's "attempt to write a
      readonly database" — the command never ran — and with only the cache's
      own files read-only the run went to its end and died there in
      the history write, a stack on stderr. Every run writes the cache
      (its record at the end, `accessed_at` on a hit, the artifact on a
      miss), so the run's cache open asks the file system first: the
      directory and, when it exists, `cache.db` must be writable
      (`accessSync`, two calls, 1.8 µs), else a `UserError` names the directory
      and `--cache-dir <path>` before the graph starts. Refuted on the
      way, twice: a trial write inside `BEGIN IMMEDIATE … ROLLBACK`
      passes on a handle SQLite opened read-only — the write lock alone,
      and then a rolled-back `UPDATE` too, because under WAL a rolled-back
      page never reaches the disk — so the check is the file system's,
      not SQLite's. Pinned in `cache.test.ts` (unit, with a writable
      control) and `cache-dir-selection.test.ts` (the CLI: exit 1, the
      one line, no task ran), both skipped as root and proven both ways
      as `probe`; `docs/cli.md` (`--cache-dir`) and `docs/caching.md`
      (§ Storage layout) say it. Read-only verbs (`vx info`, `why`,
      `last`) open the cache without the check and keep working on a
      read-only cache, as they did.
209.  DONE (2026-09-16, 208's last sentence tested rather than
      believed): the readers kept working only while every config was
      warm in the evaluation cache. With the config changed and the
      cache read-only, `vx show` died with SQLite's "attempt to write
      a readonly database" on the eval cache's store or the
      file-hash memo's upsert, whichever came first; `vx info`
      survived only because the doctor swallows a load error and counts
      loadable configs instead, `why` and `last` read history and never
      evaluate. The cache now decides at open whether the directory is
      writable (the same two `access` calls) and, when it is not, opens
      with the local WRITE axis off: the config-evaluation store already
      honoured it, the file-hash memo does now, and the `.gitignore`
      write is skipped; a run still refuses through `assertWritable()`,
      which reads that decision. Pinned in `cache.test.ts` (a read-only
      cache: `putConfigEval` and `hashFile` throw nothing and store
      nothing) and `cache-dir-selection.test.ts` (`vx show` on the
      workspace's own read-only cache with a changed config exits 0 and
      lists the project — it takes no `--cache-dir`, so the workspace's
      cache is the one that stops being writable), skipped as root and
      proven both ways as `probe`; `docs/caching.md` says it.
210.  DONE (2026-09-16, the read-only checkout, the persona 206–209
      kept naming, walked as `probe`): with the workspace root not
      writable and no cache yet, every verb died in the cache's
      `mkdirSync` with a raw stack — the readers included — and the
      lock and init verbs died the same way writing `vx-lock.json` and
      `vx.workspace.ts`. Two fixes, one general: the cache constructor
      names an uncreatable directory with its three remedies (the
      workspace writable, the `cacheDir` field, `--cache-dir`), and the
      CLI's top level and the scheduler's error branch treat a file
      system refusal (`EACCES`, `EPERM`, `EROFS`; `isPermissionError` in
      `util/errors.ts`) like a `UserError`: one line, the path, a hint,
      no stack — so the next tree write nobody wrapped reads right
      without a fourth special case. Pinned: the rule as a unit with
      controls (`ENOENT`, a plain Error carrying the word, a
      `UserError`, a non-error), the constructor on a sealed parent
      (`cache.test.ts`), and the CLI on a 0o555 workspace root (the
      show verb names the cache directory and `--cache-dir`, the lock
      verb names the lockfile, neither prints a frame) — the last two skipped
      as root and proven both ways as `probe`; `docs/cli.md` (§ vx run)
      and `docs/caching.md` say it. Next 6 on this head, after 206–210
      put two `access` calls, a guarded `mkdir` and one axis check on
      every run's cache open: 1,000 projects 232 ms warm / 711 restore /
      2,542 cold (medians of 5; the morning's 237 / 744 / 2,520, midday's
      244 / 700 / 2,570) — inside jitter, as the microseconds said.
      Considered and declined: a doctor that prints the facts it can
      when the cache directory cannot be created. Its one line is the
      diagnosis, and the alternative is a nullable facts shape that
      every `getWorkspaceInfo` consumer would have to learn for a
      persona whose fix is a `chmod`.
211.  DONE (2026-09-16, the full disk — a 2 MiB tmpfs mounts here, so
      the persona is hostable; walked as `probe`): a save that runs out
      of room already said `cache save failed: ENOSPC …` and let the
      task's work stand, but a hit's restore onto a full workspace disk
      fell through to "internal error … CorruptArtifactError: artifact
      is not a readable archive" — 207's mislabel with a different code
      — and a green run on a full cache disk printed its summary and
      then died in the history write, SQLite's "database or disk is
      full" with a stack, exit 1 over "1 success". Three changes:
      `ENOSPC`/`EDQUOT` join the refusal class (`isDiskFull`,
      `isFsRefusal`, a hint per kind) at the CLI's top level and the
      scheduler; the restore names a full disk with its own remedy
      ("Free space on that disk and re-run"); and the run record is a
      status line when it fails ("run history not recorded: … — the
      verdict above stands") — history is observability, and a run's
      exit is its tasks'. Pinned as units with controls
      (`user-error-classify.test.ts`) and end to end in
      `disk-full.test.ts` on a small file system named by
      `VX_SMALL_DISK`: a hit whose restore cannot write (the line, no
      "internal error", no "corrupt artifact") and a finished run whose
      record cannot be written (`--cache=local:r` leaves the record as
      the one write; exit 0, the line, no frame). Root is subject to
      ENOSPC like anyone, so no user switch is needed; the suite skips
      without the variable and CI's Linux job mounts a 2 MiB tmpfs and
      sets it, as the manual gate does — a gate on an env var CI sets,
      not a probe. CI's first run placed it: inside a sandboxed shard
      the mount was read-only (`EROFS` on the fixture's `mkdtemp`), a
      mount the sandbox did not make, so the suite is in the unsafe
      set — the tests a sandbox cannot host — and only that task passes
      the variable through. Both cases fail without the fix. The gate's first run caught the pin the change
      retired: `orchestrator-remote.test.ts` forced a record throw to
      prove `close()` still ran and expected the run to reject; it
      asserts the status line now, the close still. `docs/caching.md`
      and `docs/cli.md` say it.
212.  DONE (2026-09-16, the grid's last cell, as `probe`): the prune
      verb against a root-owned cache died in its first DELETE with
      SQLite's "attempt to write a readonly database" and a stack — the
      one writer verb left that opened the cache without asking. It
      asks now (`assertWritable()`, 208's check) unless `--dry-run`,
      which only reads and reads a read-only cache fine. Pinned in
      `cache-dir-selection.test.ts` (exit 1, the line, no frame; the
      dry run exits 0), skipped as root and proven both ways as
      `probe`. The other openers outside a run — the MCP tools, the
      schedule-history plugin, `why`, `last` — read, and 209 opens a
      read-only cache for them. `docs/caching.md` says it.
213.  DONE (2026-09-16, from the gate's own failure): a gate stopped
      mid-run left 255 of the sandbox runtime's mux sockets in `/tmp`
      (`srt-mux-<pid>-<seq>.sock`), and the next unsafe step, handed a
      recycled pid, met `EADDRINUSE` in the sandbox probe — every
      sandboxed task would have failed the same way after any killed
      run on a box that recycles pids. A socket file carrying THIS
      process's pid before the runtime is up can only be a dead
      process's, so `initSandbox` unlinks the contiguous run from seq 0
      (a stat per file, no scan of a `/tmp` that read 7,381 entries in
      9 ms here), guarded by a runtime-is-up flag that `resetSandbox`
      clears. Pinned in `sandbox-runtime.unsafe.test.ts`: a regular
      file at seq 0 under the current pid, and the probe succeeds and
      removes it; without the fix the probe dies on the listen. The
      manual gate clears the sockets itself too. The rest of a killed
      run's residue, checked while here: a save killed mid-write leaves
      `<hash>.tar.zst.tmp-*`, which the orphan sweep already reaps
      (refuted as a gap); the runtime's own `srt-obs-*` socket
      directories (removed on a normal stop, 186 left here by the two
      stopped gates, 4 KB each, random names, so not vx's to tell from
      a live sibling's) and its `claude-empty-*` mask directories are
      its lifecycle; and two stopped gates had left 6,537 test fixtures
      in `/tmp` (7,421 entries → 884 after the sweep) — a killed
      `bun test` leaks its fixtures, which is the test harness's, not
      the product's. Checked and left as they are, the two other doors
      the day's refusals could reach: the MCP server hands a tool's
      `UserError` back as an error result and any other error as a
      JSON-RPC error, and stays up either way; `vx watch` exits on the
      refusal with the same one line its initial run prints.
214.  DONE (2026-09-16, the deal re-weighed as `probe`): the day added
      four end-to-end cases that skip as root and a suite that runs
      only with a mounted disk, and the weights the shard dealer trusts
      were measured as root, where those cases cost nothing. The whole
      core suite ran as the unprivileged user — 2,857 pass, 1 darwin-only
      skip, 0 fail, 34 s wall on four workers — and `--weigh` took its
      JUnit: 164 files, 132→134 s of recorded
      test time, the movers `show-info.test.ts` 2→5 s, `cache-dir-selection.test.ts` 0→1 s, `flaky.test.ts` 0→1 s. The new deal predicts
      11.2 s for every shard (max/avg 1.00); the measured walls were
      9.2–13.7 s. This box hosts the suite as CI's runner sees it now,
      not only the unsafe set, so the next re-weigh has the same recipe.

**The restore arm is at its floor (2026-09-10, late night).** The
1,000-project warm-restore run spends its wall in `restore: extract`
(2.4 ms accumulated per task under four workers; `VX_TIMING=1`), so
one artifact was timed alone, sequentially, 200 reps: `restoreOutputs`
0.375 ms min / 0.75 avg, of which the five file syscalls the extractor
needs (mkdir, write temp, chmod, utimes, rename) are 0.18–0.26 ms,
zstd decode 0.02 ms, the artifact read 0.01 ms, the rows lookup
0.003 ms, `realpath` 0.01 ms. The run's 393 ms `run graph` over 1,000
restores is 0.39 ms per task — the sequential floor, overlapped. What
is left is syscall round trips on the thread pool; folding chmod into
the write (mode at open is umask-dependent, so the chmod stays for
exactness) or skipping utimes would buy ~0.05 ms each, 15–25 ms of a
434 ms run, on the stale-hit-critical path. Not worth the risk;
recorded so the next reader does not re-derive it.

**Shard weights refreshed (2026-09-10, after items 65–67).** Three
suites moved to packages and `init.test.ts` shrank, so the deal was
running on stale numbers: twelve shards side by side on this four-core
box read 11.8–14.6 s (wall 14.7 s). Re-weighed from that run's JUnit
(`--weigh`), the same files deal to 13.5 s each by the new weights
against 14.6 s for the old deal's heaviest — the wall follows the
heaviest shard, so about a second. The weights are what a twelve-way
run on four cores measures, the condition the gate runs under.

**Plugin names, one convention (2026-09-10; superseded by item 69 the
same day).** `vx info` listed the repo's own plugins as `vzn/otel`,
`@vzn/vx-github`, `vx/mcp` and `vx/schedule-history` — three spellings
across four lines. The interim answer was `vx/<thing>` everywhere; the
owner's answer is that the name is the package name and nothing else,
which item 69 enforces. No first-party plugin fills `key`, where the
name is folded into the material, so nothing re-keyed either way.

**The guide pin under the sandboxed gate (2026-09-10, after item 67).**
CI's Linux job went red on 15136a6 in `@vzn/vx-docs#test`: the plugins
guide's type-check pin exited 1 with no diagnostic line captured. The
cause was the sandbox, not the types: item 65 had pointed the pin's
tsconfig `paths` straight at `packages/vx-schedule-history/src`, a
sibling the site does not depend on, and a sandboxed task may read its
project, its `node_modules` and what those link to — nothing else. The
fix is the honest one: the site declares `@vzn/vx-schedule-history` as
a devDependency, Bun links it into the site's `node_modules`, the
sandbox grants the link target, and the pin resolves the package
through that link. Reproduced and proven differentially under the real
sandbox here, not on CI alone — a probe refuted on the way: with the
link present, even the direct path passed, so the denial was never
about the route but about an ungranted target. Recipe, since the
container runs as root and the runtime refuses a nested user namespace
there: copy the bun binary somewhere world-readable, `chmod 1777
/tmp/claude`, and run `vx run <task> --no-cache --excludeDependencies
--cache-dir <writable>` as `nobody` with `HOME` set — bwrap works for
an unprivileged user on this kernel. The pin now carries oxlint's tail
when it exits non-zero without a diagnostic line, so the next such
failure names its cause on CI.

**Two warm-path probes refuted after item 61 (2026-09-10).** Cold
config evaluation, measured by deleting `config_evals` and
`config_closures` on the warm 1,000-project copy: the `load configs`
stage reads 584 ms cold against 26 ms warm — 0.58 ms per config through
the worker, so a 2,000-project first run pays about a second there and
no batching lead exists; `scale-graph`'s 9.5 s `beforeAll` is its
generator, git and warm plan, not evaluation. And the accumulated
`output dirs` counter (52 ms over 1,000 proofs, 52 µs each for one or
two `statSync` calls) is not a cost to chase: an accumulated span
measures wall time between its start and end, and under the
scheduler's concurrency that window holds other tasks' work, so the
per-call figure over-counts. The rule for the stage table: stage rows
are exclusive and comparable; accumulated rows are upper bounds.

**Profiles after item 50 (2026-09-10).** `bun --cpu-prof` on the
pre-warmed 1,000-project copy, third run of three. `vx show` (93 ms
sampled): 28% in the discovery closure (`workspace.ts:303` — the
per-package readdir + manifest read, async continuation attributed to
the closure), 11% `JSON.parse` of manifests, 5% `listProjects`, then
the staged load and the eval-cache keys at 1–3% each. Warm `vx run`
(228 ms sampled): `statSync` 9% (the two output proofs, 2,000 stats,
chosen sync by the 2026-09-09 A/B: 100 → 54 ms on the run-graph
stage), `findConfigFile` 5%, `bun:sqlite` query 3.5%, package graph
2.5%, `hashProjectPackageJson` 2.4%, then a long tail under 2%. No
new hot spot: every frame over 2% is a measured decision already
recorded (discovery 8(e), the proofs' sync stats, the manifest hash).
The next warm-path gain is structural (8(e)'s stat-keyed discovery
memo), not a frame.

**Warm path after item 46 (2026-09-10).** Interleaved A/B, 1,000
projects, twelve reps, both orders, base = the immutable c0b20ca
worktree: main min 225 / med 242 ms vs head 231 / 246 in one order,
head 221 / 233 vs main 222 / 232 in the other — a tie inside
run-to-run jitter, the sign flipping with the order. The reset
property read (39), the env field check (44, on the eval path only)
and the orphan scan (35, prune only) cost the warm run nothing
measurable.

**Handoff after item 45 (2026-09-10, morning).** PR #265 carries the
loop, 70+ commits; every head is green on CI except the ones a
same-day commit fixed (d295a90 timing, 1414cf2 `.mcp.json`, f549719
unformatted tables, 92e1682/f4a0d48 a doc law reading outside the
sandbox — each recorded above). The shape since item 31: the owner's
two asks (item 43's `vx lock` report and item 45's suite speed) both
resolved to measurement first — a repro that round-trips, a JUnit
timing pass — and each fix carries a pin that fails on the old code;
three probes became laws (`doc-references`, `schema-unknown-keys`,
`sandbox-hint`); the reset notice (39), the orphan sweep (35) and the
doctor's orphans row (41) close the schema-bump story end to end. The
suite runs ~95 s of test bodies across eight shards on four cores;
what remains over a second is real work (rate floods, an 87k-edge
graph, Worker spawns, ~130 end-to-end CLI spawns at ~100 ms). Start
the next session from Next § 8: (e)/(f)/(g) are open with reasons;
(c) is done for every verb but `vx lock`, on purpose. The scratchpad
harnesses (`ab2.ts` warm, `ab3.ts` cold, `abshow.ts` for `vx show`,
`junit/` for suite timing) take two worktrees and two workspace
copies; recreate the copies with the bench generator.
Next-list 8(b) decided: `--max-size` keeps reading a bare integer
as bytes — it is pinned (`cli-arg-hygiene`: `--max-size 1` is one
byte), documented as `<bytes>`, and the zero bound is the guard;
refusing unitless there would reverse an earlier call for one
footgun the docs already name.

## In flight

**Open after the sandbox arc (2026-09-05).** Its four Linux items
closed by 2026-09-10 — the docs build under bwrap, strace's seccomp
filter, a sandboxed port, persistent tasks inside their sandbox; the
record is in `docs/history/2026-09-status-next-log.md`. What stays
open is the one that needs a macOS box:

5. **macOS violation reporting is lossy while any violation fails the
   task.** The unified log drops records under load, so the same task can
   pass or fail run to run. Enforcement is unaffected — the OS denied the
   operation either way — but the REPORT is not a reliable gate on that
   platform.

**Releases.** v0.0.21 is on npm, the four platform packages with it
(2026-09-15, handoff 14d in the history file), published through
`npm.yml`, which reads no secret and sets no token — its publish is the
OIDC exchange or nothing — so the trusted publishers on npmjs.com are in
place. The v0.0.18 record (the token's `E401`, the held packages, the dry
run of the token-free workflow) moved to the history file with the
items above.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. DONE by 2026-09-15 (0.0.21 published through the token-free
   `npm.yml`, so the trusted publishers exist). OWNER residue: delete
   the `NPM_TOKEN` repository secret if it still exists — nothing reads
   it. Documented in `docs/cli.md` § Releasing.
2. OWNER: cut the release — a GitHub release with the tag is the whole
   process (`release.yml` builds and signs the binaries, `npm.yml`
   publishes with provenance). Pick the version the articles will name;
   `0.1.0` says "first real release" where 0.0.19 says "another nightly".
   The release notes are the changelog — there is no CHANGELOG file, and
   GitHub's generated notes from merged PR titles are accurate since
   every merge is one titled PR.
3. OWNER: the site's address — it deploys to
   https://vznjs.github.io/vx/ on every push to main (`docs.yml`). A
   custom domain is a DNS record plus `SITE_URL` / `BASE_PATH` env in
   that workflow (`astro.config.mjs` reads both); every internal link is
   base-relative, so nothing else moves.
4. DONE 2026-09-10: the blog and its thirty posts, README and site
   numbers, LICENSE holder, SECURITY.md, CONTRIBUTING.md (items 115,
   116, 118).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. Known limits an article should state plainly: Bun ≥ 1.4 for source
   installs (the binary needs nothing); Linux sandboxing needs
   `bubblewrap` + `socat` and cannot run as root inside a container;
   Windows is WSL; macOS violation reporting is lossy under load
   (In-flight 5); the remote seam moves whole artifacts in memory
   (Next 2, fine below ~100 MiB).

## Next (ordered)

0. DONE 2026-09-10 as item 87 (history) — core has no `build`; dependants stop compiling the release binaries.
1. **The live REAPI suites are green again (2026-09-04); the
   whole-graph run stays optional.** With OrbStack's docker back, the
   rehosted `vx-nativelink:bun-node` image on
   `tests/helpers/nativelink-exec.json5` ran all ten `@vzn/vx-reapi`
   files one process each with both endpoints set: 121 pass, 0 fail —
   the wire-level execution suite (15), the cache suite (16) and the
   `execute: true` composition proof (2) included, so the barrel
   narrowing and the by-name error classification (2026-09-03) changed
   nothing live. Not done: `vx run ci --all` of THIS repo at a worker —
   it needs a workspace that wires `reapi({ execute: true })` (none is
   checked in) and filesystem stores (the memory stores evict under a
   `node_modules` install, per the helper notes). An exercise, not a
   gap; do it when a worker-side change needs it.
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started. Assessed 2026-09-04: the win is gated by the PLUGIN
   side — `@vzn/vx-reapi`'s wire zstd-compresses the whole body in
   memory and retries a wedged upload from it, so a core-side Blob alone
   measures nothing; streaming needs a two-pass digest and a chunked
   compressed upload through the adaptive-downgrade path. Do it when a
   real workspace uploads > 100 MiB artifacts, not before.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 179 (2026-09-15, a tie), and the restore arm's floor is the
   note under item 193.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) only `vx lock` reads config files raw, on
   purpose — grep for `loadProjectConfig(` before adding a fourth
   consumer of the staged load; (d) `logger.ts` and `framed-output.ts`
   are the last large files, and neither splits cleanly (one renderer,
   one formatter); (e) REFUTED: a discovery memo keyed on directory and
   manifest stats saves ≈ 3–4 ms of a 230 ms run for a second staleness
   surface — revisit only if discovery's share grows; (g) `vx why` shows
   a plugin `key` part's digests, not its material, because a raw
   column is a `SCHEMA_VERSION` bump or a persisted secret — revisit
   when a plugin's part is the thing people debug.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. The handoffs after items 153, 130, 166, 170, 176, 183 and 189
    (14–14f) are in `docs/history/2026-09-status-next-log.md`; 14g
    below is the current one.

14g. **Handoff after item 192 (2026-09-16, small hours).** Three
items since 14f: the plugin author's walk refuted nothing (190); the
agent's walk over the MCP wire gave `whyDidThisRerun` its default
run through a query the CLI now shares (191); and that PR's first CI
run exposed item 170's pin on a knife edge — a light child's
`ru_maxrss` equals the parent's mark by construction, the kernel's
RSS counters lag by pages, and an exact comparison flipped once in
twelve runs — so the floor has 4 MiB of slack now (192; the rule is
in CLAUDE.md). Ten walks since 14d: eight fixes, two refutations;
every persona this box can host has been walked once (the REAPI
operator with live services has not — no docker here). Open: Next
1, 2 and 16 as before, all gated; the launch checklist's owner
steps; no open issues. The box: unchanged. Methods that paid: read
a red CI job's own log before calling anything a flake — the failing
pin was in code the diff never touched, and it was still a real
knife edge, fixed with a differential pin rather than re-run; a
walk's refutation is written down (186, 190) so the next reader
changes angle. Never end with "what next?".

14i. **Handoff after item 202 (2026-09-16, early morning).** Five
items since 14h, three of them from walking the CI persona and the
maintainer through `.github/` rather than a scratch workspace: § In
flight cut to what is open (198); `--affected` in the two clone shapes
CI produces — a base that is HEAD itself is named, a depth-1 checkout
gets "a shallow clone?" instead of a `HEAD~1` nobody typed, and the
site's own recipe, which had the first shape on every push to main,
diffs against `github.event.before` now (199); the CI guide names
`@vzn/vx-github` (200); the release paragraph and the npm workflow's
header stopped claiming a token path the file lacks — 0.0.21 went
through the token-free workflow, so launch-checklist 1 is done bar
deleting a secret nothing reads (201); and the vx-cloud agent action,
a leftover of the removed product, is gone (202). The shard re-deal of
item 196 exposed a second deal-shaped edge on its third CI run
(`output-dirs`' 8,193-directory case against bun's 5 s default, bounded
by its work). Open: Next 1, 2 and 16 as before, all gated by their own
terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret,
the release cut, the site's address. No open issues. The box:
unchanged. Methods that paid: a persona's first REAL failure comes
from the environment it runs in (a single-branch clone, a depth-1
checkout), not from the verb's flags; read the CI job's own log before
calling a failure a flake, and read your own recipe with the same eyes;
a comment claiming behaviour the file lacks is a defect wherever it
sits, a STATUS line repeating it included. Never end with "what next?".

14j. **Handoff after item 208 (2026-09-16, morning).** Six items
since 14i, all from one persona taken one step further each time:
the root-in-a-container box, where the sandbox refuses to nest, got a
`sandbox` row in the doctor (203) and then an unprivileged user
(`probe`), which turned the docs' first remedy into a fact (204) and
the box into a host for the whole sandboxed gate — `vx run ci --all`
with the sandbox required, 44 of 44, the unsafe set 78 pass (205; the
session's manual gate runs the unsafe step that way now). Walking as
that user found the class the walk was for: three touches of a tree
the process may not write — the clean (206), the restore (207), and
the cache directory itself (208) — each an "internal error" before,
each a `UserError` naming the path and the remedy now, each pinned on
a 0o500 directory, skipped as root and proven both ways as `probe`.
Merged as #372–#375; 208 rides the next. Refuted on the way: a trial
write under WAL proves nothing about a read-only cache (208), and
`chmod 500 .vx` alone proves nothing either (207). Open: Next 1, 2
and 16 as before, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The box: a `probe` user, a copy of
bun at `/opt/probe-bin/bun`, `HOME=/tmp/probe-home`; the traps are
in 205 (bun's per-build `node` shim under `/tmp`, owned by whoever ran
first — remove root's before a non-root run). Methods that paid: a
persona is worth a second and third step, not one; grep the class of
a fix by walking it, not by reading (207 and 208 were not in the code
206 touched); a probe that passes for the wrong reason is caught by
running it without the fix (208's first two probes passed on the old
code too). Never end with "what next?".

14k. **Handoff after item 211 (2026-09-16, morning).** Three items
since 14j, the same walk carried to the tree's other refusals: the
readers open an unwritable cache read-only and go on (209, the
file-hash memo took the write axis it had ignored); a read-only
checkout with no cache yet, and the verbs that write the tree, print
one line naming the path instead of a stack — the file system's
refusal is a `UserError` at the CLI's top level and in the scheduler,
one rule for every write nobody wrapped (210); and a full disk, which
a 2 MiB tmpfs makes hostable here and on CI, is reported the same way
at the restore, and a run whose history cannot be written keeps its
verdict (211; `disk-full.test.ts` behind `VX_SMALL_DISK`, mounted by
CI's Linux job and the manual gate). Merged as #377–#378; 211 is
#379. Refuted or retired on the way: a doctor that prints partial
facts on an uncreatable cache directory (declined under 210 — its one
line is the diagnosis); the pin that made a record throw reject the
run (it asserts the line now). Next 6 closed the day at a tie (under
210). Open: Next 1, 2 and 16 as before, all gated by their own terms;
In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret, the
release cut, the site's address. No open issues. The box: as 14j,
plus `mount -t tmpfs` works here as root (the small disk). Methods
that paid: a persona's refusals come in kinds (permission, space) and
each kind has three sites (clean, restore, record) — walk the grid,
not the first cell; a claim in STATUS ("the readers keep working") is
a test to run before it is a sentence to keep (209 came from testing
208's last line); when a fix retires a pin, the pin's claim usually
survives in another shape (close still runs) — keep the claim, change
the shape. Never end with "what next?".

14h. **Handoff after item 197 (2026-09-16, small hours).** Five
items since 14g: the one dependency that had moved (193), this file
cut to a handoff again — loop items 105–144 and the Next list's
record to `docs/history/` (194, 195), 2,657 lines to about 1,300 —
and CI's wall time worked from its own job log: the core suite back
to the average shard (196: the watch-loop suite had grown to a shard
of its own; split three ways and re-weighed, the run 52 → 35 s here,
and the re-deal exposed an RSS pin that trusted the alphabet), then
the REAPI suite's 15 s wait pinned on the instance instead (197).
CI's three jobs, #362 → #364: lint·format·test 2:19 → 1:42, plugin
packages 1:18 → 0:51, core tests (macOS) 2:07 → 1:33. Next 6 duty,
this box, `run.ts` medians of 5 after the day's merges: 100 projects
112 ms warm / 158 restore / 380 cold; 1,000 projects 237 / 744 /
2,520 — the warm rows on 2026-09-10's (123 / 240), the restore row
at 1,000 well under it (1,163; the usage sidecar and the restore
lane since). No warm-path code moved today beyond item 192's compare.
Open: Next 1, 2 and 16 as before, all gated by their own
terms; no open issues; every persona this box can host has been
walked. The box: unchanged. Never end with "what next?".

15. DONE 2026-09-11 as items 142–144, 150 and 152 — five Nx repos
    (query, strapi, novu, router, refine), the owner's 3–5. Was: **More Nx repos.** The five Turbo build sets, the two wide sets
    (item 141) and four Nx repos (items 142–144, 150) are in.
    Both gaps from the first Nx repos (item 142) are closed: `.mjs`
    output is item 145, two targets on one output path item 146. Then the harness on more
    Nx repos (owner: 3–5 popular ones; only
    `nx:run-commands`, `nx:run-script`, a plain `command` and
    `nx:noop` targets are supported, anything else is out): the
    remaining candidate was storybook (483 targets inheriting a plain
    `command`; its placeholders and root cwd map since item 147): its
    install does not fit this box — the fetch step filled the 6 GB
    left on the disk with the yarn cache alone (ENOSPC, 2026-09-11) —
    so it waits for a bench host with room; redwood is dropped — its
    `build` declares no outputs, so Nx's cache replays the log and a
    restore arm restores nothing under either tool (REPOS.md). Parity
    is the task graph as above.

16. **Two cached tasks on one output path, when one depends on the
    other.** Two of the five Nx repos have it: strapi's `build:types`
    and refine's `types` write `dist/**/*.d.ts` into the `dist` their
    package's `build` fills, and both declare `dist` as the output of
    both targets; Nx caches both, vx leaves the dependent one uncached
    (item 146 resolves the overlap at migration time). What blocks it
    is the clean: vx removes a task's declared outputs before it runs
    and before a restore, so a `types` miss under a `build` hit would
    delete the `dist` that `types` reads. A design that admits it:
    when B's outputs overlap A's and B depends on A, B's own output
    set is the files its run ADDED or CHANGED (a snapshot of the
    overlap before B runs, diffed after — size + mtime, the proof the
    hit path already trusts), B's clean removes only that set, and B's
    artifact holds only that set; the restore order follows the edge.
    Cost: one stat walk of the overlap per B miss, none on a hit. The
    catch, seen while writing this: refine's `types` ADDS nothing —
    `build` is `tsup && node ../shared/generate-declarations.js` and
    `types` is the second half again, so it REWRITES `build`'s `.d.ts`
    files with the same bytes and new mtimes. Under the design above
    B's own set is empty (same bytes) but A's proof is size + mtime,
    so the next no-op finds A's outputs moved and restores them — a
    restore where there was nothing to restore, every run. Either the
    proof compares content for files a downstream task touched (a hash
    per overlapped file, the cost the proof avoids by design), or a
    rewrite-in-place stays refused and only additions are admitted.
    strapi's `build:types` (tsc into the `dist` rollup filled) is the
    addition case; refine's is the rewrite. Not started; do it if a
    third repo shows the addition shape, with the design note first
    (`docs/design/`), and leave the rewrite refused.

17. DONE 2026-09-12 as item 158 — the producing execution's usage rides
    the artifact's sidecar; a hit's entry is the history's record.
18. DONE 2026-09-15 as item 176 — measured a 21% loss (132 vs 160 s
    on 92 builds); cores are declared, never learned.

## Decisions (this arc)

- **Resources are the schedule plugin's (owner, 2026-09-12).** Core
  gates on the worker count and asks the `admit` stage for anything
  finer; it holds no per-task cores or megabytes, no config field for
  them, no budget flag. What a task needs is learned from what it used
  (`@vzn/vx-schedule-history`), or declared to that plugin. Item 157.
- **No first-party technology plugins (owner, 2026-09-10).** A plugin
  that gives packages tasks from a framework's config (`vite()`,
  `next()`, …) is the community's to write on the `project` stage; core
  names no tool, and this repo ships no such plugin. `turbo()` in
  `@vzn/vx-migrate` is an adoption plugin, not a technology plugin, and stays.
- **Windows is WSL (owner, 2026-09-10).** vx spawns POSIX shell and ships
  linux / darwin binaries; a Windows developer runs it under WSL, and the
  docs say so instead of listing Windows as a gap.
- **One core per process (2026-09-10).** The running `vx` serves its
  own façade to every `@vzn/vx` import it evaluates. A plugin package
  never carries its own copy of core into a run; the host decides the
  runtime, as any host does. Item 77.
- **The façade names only what has a consumer (2026-09-10).** An
  export written for a consumer that no longer exists is a promise
  nobody collects and a surface nobody may change; item 78 took 41
  of them off. Core keeps every function behind its module contract;
  a new consumer widens the façade deliberately, with the pin.
- **No seam without a consumer (2026-09-10).** The `CASBackend` /
  `Digest` substrate left core after three months with zero callers
  (item 74). A content-addressed view of the artifacts directory comes
  back when a plugin needs it, shaped by that plugin's use — not
  before. The same rule retired `recordRun` / `recordRuns` from the
  layer contract (item 72).
- **Merge your own PR once it is green (owner, 2026-09-10, "Merge
  whenever you own the project").** The session's PR flow stays
  (branch, PR, CI), but a green, mergeable PR no longer waits for the
  owner's word; the next PR starts from the merged main.
- **A plugin's name is its package name; no overrides (owner,
  2026-09-10).** `definePlugin(import.meta, hooks)` reads it and stamps
  it; the workspace loader refuses anything else. Item 69.
- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is the only must no plugin can supply; parked.
  Full table in `docs/comparison.md` § Gap audit 2026-09-04.
- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
