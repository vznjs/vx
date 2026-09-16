# Shipped, 2026-09 — improvement-loop items 145–202

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`; items 243 onward continue in
STATUS under the same numbering.

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
