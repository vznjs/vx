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
`docs/history/2026-09-status-next-log.md` the same night), and items
145–202 to `docs/history/2026-09-improvement-loop-145-202.md` later
that day (the 2026-09-10 measurement paragraphs to the 65–104 file, and
handoffs 14g–14i to the next-log file), and items 203–242 to
`docs/history/2026-09-improvement-loop-203-242.md` that night (handoffs
14j–14p to the next-log file), and items 243–281 to
`docs/history/2026-09-improvement-loop-243-281.md` that afternoon
(handoffs 14q–14v to the next-log file), and items 282–305 to
`docs/history/2026-09-improvement-loop-282-305.md` that evening
(handoffs 14w–14y to the next-log file), and items 306–332 to
`docs/history/2026-09-improvement-loop-306-332.md` late that night
(handoffs 14z–14ad to the next-log file), so this file stays the handoff
and not the log; numbering continues from there. Keep
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

333.  DONE (2026-09-16, the trim 14ae named): items 306–332 moved
      whole to `docs/history/2026-09-improvement-loop-306-332.md` and
      handoffs 14z–14ad to `docs/history/2026-09-status-next-log.md`,
      the record paragraph and every earlier history head repointed,
      each removed line checked present in its new file before the
      write. The loop holds this entry; 14ae stays as the current
      handoff.
334.  DONE (2026-09-16, the site's two oldest pages: the
      trusting-the-cache guide, 09-05, and the why-vx-is-fast concept,
      09-10). The guide's `vx why` sample had two spaces where the
      formatter pads one; its "no config evaluation" is no PROJECT
      config (the workspace file is evaluated for the cache directory
      unless `--cache-dir` names it); its verdict table paraphrased
      three endings where `metrics.ts` prints five sentences — the
      page now quotes all five and the site-samples law holds them to
      the source, with the sample's labels and row shape held to
      `why.ts`. The run id in the samples (`019f5a02-…`) is right:
      `ulid()` is `Bun.randomUUIDv7()` since the hand-rolled ULID
      went, so the three copies (cli.md, the guide, the blog) stand.
      The concept page said the bitset priority computation went from
      8.5 s to "roughly 50 ms" (optimizations.md: single-digit ms),
      the config-eval cache is "worth ~20 ms" (benchmarks.md: the
      `load configs` stage is 16–25 ms per 1,000 configs against
      ~200 ms of evaluations), and "Turborepo and Nx stop at direct
      dependencies" on sparse `^task` bridging — unproven, and the
      parity record shows Nx reaching through a target-less project
      with dummy tasks, so the comparative claim is dropped and the
      vx property stated. Its eleven figures are now the benchmarks
      page's, as written, and pinned to it. Three pins fail on the
      old pages.
335.  DONE (2026-09-16, the three oldest blog posts: hello-vx,
      flaky-tasks, the-local-floor). hello-vx reads true. flaky-tasks
      named `getRunHistory` as the MCP tool that reports flaky tasks;
      it is `getWorkspaceInfo` (the standing list the doctor keeps);
      its footer sample is now `formatFlakySection` on the two
      findings it describes, pinned. the-local-floor said a sandboxed
      task declines remote placement — so did the remote-execution
      guide — and `pinnedLocalSet` had no such rule: a sandboxed
      cacheable task was offered to a remote executor, which enforces
      no sandbox and reports no violations, so the boundary the task
      declared held only when the local floor happened to take it.
      Implemented: `exec.sandbox` pins a task and its dependants
      local, beside persistent and `exec.remote: false`;
      `tests/placement.test.ts` (new) holds the five pin cases, the
      two sandbox ones failing without the rule; every written copy
      of the rule (placement.ts, executor.ts, placement.md,
      executor.md, schema.md, the remote-execution guide) says so.
      The post's `--dry` label sentence now says the label appears
      once more than one executor is declared; `@local` and `@noop`
      pinned to their names. The post pins are controls.
336.  DONE (2026-09-16, the next three oldest posts: no-daemon,
      one-binary, strict-output-ownership). one-binary reads true
      (four platform packages, Bun ≥ 1.4 from source only, the 51 ms
      solid run). no-daemon said the bitset priorities take "tens of
      milliseconds" (optimizations.md: single-digit) and spelled its
      warm figures its own way; they are now the benchmarks page's
      (510ms, 760ms, 3.59s; 51 ms to 95 ms on solid), pinned to it.
      strict-output-ownership's "never touched" list named `.vx` and
      `.git` and not `node_modules`, the third of `ALWAYS_IGNORE`; the
      list is pinned to that constant. Its overlap rule (equal
      literals, a literal a glob matches, identical globs; anything
      else let through) and the `(size, mode, mtime-ms)` fingerprint
      read true against `task-graph.ts` and `cache.ts`. Two pins fail
      on the old posts.
337.  DONE (2026-09-16, the next three oldest posts: why-did-this-rerun,
      ctrl-c, lock-and-frozen). ctrl-c and lock-and-frozen read true
      (the 2 s grace and its two names, 130/143, the second Ctrl-C,
      `aborted`, the nested-run refusal on `VX_RUN_WORKSPACE`; `--check`'s
      hash plus re-evaluation, the lock off every key). why-did-this-rerun
      had the guide's four faults (item 334) — the verdict table now quotes
      the five sentences, held by the same pin — and named six of the ten
      component kinds `cache.ts` records; it and cli.md now name all ten
      (`runtime`, `ws-runtime`, `forward` and `plugin` were missing from one
      or both), pinned to the `kind:` literals. And a correction of item
      336: the strict-output post's "never touched" list was extended with
      `node_modules` on the premise that `ALWAYS_IGNORE` guards the wipe;
      it does not — `resolveOutputs` excluded only nested projects, and
      `node_modules/**` IS an install task's output (the remote-execution
      guide's recipe). inputs.md said the same wrong thing. The post's
      original two, `.git` and `.vx`, were a guarantee the code lacked: a
      root project declaring `**` would have emptied its repository and the
      cache it restores from. Implemented as `OUTPUT_NEVER` in
      `resolveOutputs`, `tests/output-wipe-guard.test.ts` (new; both cases
      fail without it), inputs.md and caching.md say so, the post's list is
      `.git` and `.vx` again and pinned to the constant. Four site pins fail
      on the old pages.
338.  DONE (2026-09-16, the next three oldest posts: watch-mode,
      lockfile-aware-keys, one-command-per-task). one-command-per-task
      reads true (`sh -c`, the two always-set variables, the retired
      inference package). watch-mode said a silent watcher is "kept
      with a warning" (it is replaced by a poller), "editor swap
      files" (the suffix list is `.tsbuildinfo` and a trailing `~`),
      and four rejected flags of seven (`--graph`, `--report-file`,
      `--verbosity` missing); its debounce, probe timeout, ignore
      lists and rejected-flag set are pinned to `watch.ts`.
      lockfile-aware-keys carried the "2 of the gate's 61 tasks" count
      the lockfiles guide dropped in 303, and said every project folds
      the catalogs (the pnpm parser folds none; `bun()` does) — both
      corrected. Three pins fail on the old post.
339.  DONE (2026-09-16, the next three oldest posts: agents-and-mcp,
      cascade-through-inputs, explicit-over-magical). The last two
      read true (upstream keys are the tenth of twelve key parts, the
      −6.6% restore tier, early cutoff shipped in v21 and reverted in
      v22, Turbo's `**` hashing on solid). agents-and-mcp tabulated
      five tools of six (`getWorkspaceInfo` missing) and sized the
      protocol at "about a hundred lines" (`server.ts` is 144); the
      table is pinned to every `name:` in `tools.ts`. And a correction
      of item 335: the flaky post's "`getRunHistory` reports the same
      signal" was right — its rows carry each task's failure mode from
      `failureModeOf`, the retry-or-mixed-key signal — and 335 replaced
      it with `getWorkspaceInfo`, which reports the doctor's standing
      list, a different fact; the sentence now names both tools for
      what each reports. One pin fails on the old post.
340.  DONE (2026-09-16, the next three oldest posts:
      telemetry-never-breaks-a-run, dev-servers-in-the-graph, the
      why-vx-is-fast post). The first two read true (the five-field
      sink contract and the 3 s flush bound; `readyWhen` with the
      trailing partial line, `exec.timeout` as the readiness bound,
      ready-on-spawn, the foreground exit line, no violation report
      for a server the run tears down); the telemetry post's interface
      block is now pinned to `TelemetrySink`'s fields and its `wants`
      union to the record kinds. The why post had the concept page's
      two faults (item 334): "roughly 50 ms" for the bitset priorities
      (single-digit ms) and its own spelling of the warm figures; nine
      figures are now the benchmarks page's, pinned. One pin fails on
      the old post.
341.  DONE (2026-09-16, the next three oldest posts: the bitsets /
      scheduler post, resolved-config-hashing, keys-from-git — the
      key-and-scheduler trio). The bitsets post was the last carrier
      of the "about 50 ms" bitset figure items 334, 336 and 340 struck
      from four other pages (`computeReverseDepCount`: single-digit ms
      at 3,270 tasks, 1.3 MB of closure); it also described one
      `Uint32Array` per row (there is one for the whole closure) and
      put the restore tier "at low priority" when it is a second heap
      with its own cap (`2 * concurrency`, serial under
      `--concurrency 1`) that the tick drains after the exec tier.
      resolved-config-hashing named eight of the twenty-two denied
      globals `IMPURE_RE` holds, said nothing of the escape and
      bare-import refusals or the 32-file closure bound, keyed the
      eval cache on the import closure alone (the fingerprint and the
      Bun and vx versions are in it too), and carried item 334's
      "worth about 20 ms" (16–25 ms per 1,000 configs against ~200 ms
      of evaluations). keys-from-git said `\0` delimits the twelve
      parts (a label per part does; `\0` separates name from value
      inside a pair), named one prune of three and one git command of
      four: `ls-files -s -v` reads the index, the one worktree walk is
      `status -uall` (which is also the untracked enumeration), and
      `skip-worktree` / `assume-unchanged` is the second prune. It
      gave SHA-1 as the blob algorithm with no mention of
      a `--object-format=sha256` repository. Its part list is
      caching.md's numbering, so the post now says what the doc says:
      the plugin part folds right after the upstream keys, before the
      files. Ten pins in `site-samples.unsafe.test.ts`, nine of them
      failing on the old pages (the twelve-parts count is a control).
      Two finds beyond the three pages: caching.md's numbered list had
      item 11's file paragraphs (globs as a filter, the index-OID
      prunes, symlinks) stranded UNDER item 12, so the plugin item now
      ends the list; and the "O(N+E) scheduler tick" the house repeats
      omits the ready heap — `ReadyHeap` is a binary max-heap, so a
      run is O(E) decrements plus an O(log N) heap operation per
      enqueue and per dispatch. Corrected in the class: this post's
      title, the why-vx-is-fast post and concept bullet,
      `optimizations.md` row 9 (whose invariant still named the
      binary-search insert the heap replaced) and
      `modules/scheduler.md` ("two sorted ready queues").
342.  DONE (2026-09-16, the three adoption pages: honest-benchmarks,
      from-turborepo, from-nx). honest-benchmarks spelled the cached
      and CPU figures its own way and rounded the CPU trio (35 s for
      34.61s, 73 s for 1m 13s, 114 min for 114m 06s) — items 336 and
      340's fault on two other posts — and said "the cold column is
      CPU time" of a table whose first two columns are wall clock; it
      now quotes the benchmarks page as written, names the versions
      the synthetic run used (Turbo 2.10.12, Nx 23.2.0, macOS arm64,
      concurrency 10) beside the solid run's Turbo 2.10.10, and says
      what compare.ts does — Turbo and Nx run with their daemons on,
      as a user would, each one stopped before the next runner is
      timed. from-turborepo's mapping table named seven of the nine
      keys `KNOWN_TASK_KEYS` holds (`extends` only in prose,
      `outputLogs` nowhere) and two of the three globals the mapper
      reads; and "`--continue` defaults to `deps-ok`" confused the run
      with the flag — the run with no flag is `deps-ok`, bare
      `--continue` is `always`, the Turbo convention, and
      `--continue=never` is what Turbo does by default. from-nx said
      the migration infers "`@nx/vite:*`" and four more where
      `KNOWN_EXECUTORS` holds eight named ones (two of them
      persistent), and its table promised a preset file for
      `targetDefaults` that no Nx migration writes — the resolved
      graph has already applied `targetDefaults` and `namedInputs`, so
      there is nothing left to map — and mapped `parallelism: false`
      to a reservation without comparison.md's `--concurrency 1`.
      Eight pins, seven failing on the old pages; the nx-cache wire is
      a control. Every remaining post is now read except
      pipeline-with-seams, remote-execution, the-sandbox and
      config-in-typescript (and the three PR #487 holds).
343.  DONE (2026-09-16, the three internals posts: pipeline-with-seams,
      the-sandbox, remote-execution). pipeline-with-seams tabulated
      eleven of the thirteen `PLUGIN_HOOKS`: `admit` was in neither the
      diagram nor the table, and `teardown` rode inside `setup`'s row —
      the shape PR #487 found in what-vx-is on the same list. Its table
      is now the list in the list's own order, pinned to it, and
      `@vzn/vx-schedule-history` is named on both the stages it fills.
      the-sandbox named two of the three binaries the Linux runtime
      requires (`rg` expands its mandatory deny globs; the runtime's own
      error has named all three since item 246, and its docblock records
      the minimal image that failed on the third), eight of the nine
      `SandboxGrants` keys (`gitConfig`), and called `allow` plus
      `ignore` "the whole permission surface" with no word of `deny`,
      which is evaluated first. remote-execution reads true: its four
      placement rules are `pinnedLocalSet`'s fields, `@vx/reapi` is the
      executor's own name (the plugin's name is its package name; the
      executor's is not), and the cache-only decline is `caps.execEnabled`
      with a warning. Five pins, four failing on the old pages; the
      remote-execution pair are controls. Left in the blog:
      config-in-typescript, plus the three PR #487 holds.
344.  DONE (2026-09-16, config-in-typescript — the last post outside
      the three PR #487 holds). It reads true on the shape it teaches:
      `defineProject` returns its argument, `vx init` and
      `@vzn/vx-migrate` write `satisfies ProjectConfig` over a
      type-only import, and the runtime-import cost is schema.md's
      ~17 ms on a two-package workspace (the post said "a small
      workspace" and now says which). Two faults: the preset snippet
      a reader copies used `ProjectConfig` with no import line — the
      one config block on the site the type-check pin skips, because
      its relative preset import puts it outside that pin's reach —
      and its impure-config list named five globals as if they were
      the list, where the gate holds twenty-two (item 342 named them
      all on the hashing post; this one now points there instead of
      repeating five). Two pins, both failing on the old page. The
      blog is read out: every post has been read against source once,
      except the three PR #487 holds. Next in the queue are the site
      guides, oldest first — `mcp`, `otel-bridge`, `sandboxing`.
345.  DONE (2026-09-16, the three oldest site guides: mcp, otel-bridge,
      sandboxing — the queue's turn from the blog to the guides). The
      MCP guide carried item 339's fault in its own words: "about a
      hundred lines" of a 144-line `server.ts`, and "three methods"
      where the source answers four (`ping` besides). 339 had fixed
      the post's body and left its heading saying a hundred, so both
      pages now say "about 150 lines" and both are held to the file's
      line count within a rounding — a round number passes, a 30% one
      does not. The sandboxing guide said vx's own test suite is "the
      one task in this repo with no sandbox block"; there are exactly
      two (CLAUDE.md's pair: `test.bun.unsafe` and
      `@vzn/vx-reapi#test`), and the pin now counts them out of the
      workspace's configs, failing loudly if its parser finds none.
      otel-bridge reads true: every `vx.*` attribute and span name it
      prints is one the exporter writes (52 in the source), and its
      option table matches `plugin.ts` down to the 15000 ms timeout.
      Five pins, three failing on the old pages; the MCP tool table
      and the otel attribute list are controls.
346.  DONE (2026-09-16, the next three guides: ci, workspace-config,
      remote-caching). The CI guide sold `--frozen` as "roughly 10–21%"
      off a warm run, a figure the 2026-09-12 head-to-head replaced:
      read the row as a tie — plain 177 ms median against frozen's 165
      on the 1,000-project bench, and that 5% is the per-config
      identity stat, not evaluation, since the config-eval cache
      already serves a pure config without evaluating it while
      `--frozen` parses and re-validates the whole lock. The guide now
      states the measurement and sells the guarantee, pinned to
      benchmarks.md. workspace-config documented three of the four
      `WorkspaceConfig` fields — `timeout`, the lowest-precedence
      per-task fallback under `exec.timeout` and `VX_TASK_TIMEOUT`,
      had no section; it has one, and the pin holds a section per
      field. remote-caching called `RemoteCacheLayer` "a three-call
      seam (`has`/`get`/`put`)": there is a fourth, the optional
      `hasMany` that answers N probes in one round trip, which is the
      one a plugin author most wants to know about. Three pins, all
      three failing on the old pages.
347.  DONE (2026-09-16, the next three guides: caching, tasks,
      running-tasks). running-tasks reads true (its `--dry` block is
      already rendered by the site-samples law, and its flag table
      says "useful", not "every"). caching spelled the three warm
      figures with spaces where the benchmarks page writes 510ms /
      760ms / 3.59s — the class items 336, 340 and 342 struck from
      four posts — named four of the six `ALWAYS_IGNORE` entries
      (`vx-lock.json` and `*.bun-build` missing), and its stale-hit
      checklist never mentioned `vx why`, the verb built for that
      question. tasks listed three of the six `exec` fields beyond
      `command`: `timeout`, `retries` and `remote` were absent, and
      its workspace line named `concurrency` and `cacheDir` without
      the `timeout` item 346 had just documented. The find beyond the
      three: `exec.resources` LEFT the config on 2026-09-12 with the
      reservations (a config that declares it is refused as an unknown
      field, `resource-estimates-2026-09.md`), and four places still
      name it as live — CLAUDE.md's own live-invariants line,
      `config.ts`'s sandbox docblock ("the same spawn `env` and
      `resources` do"), schema.md's "stripped … the same as
      `resources`", and cli.md's list of the fields `vx show` prints,
      which cannot print it. All four corrected; the `vx show` list is
      now pinned to the `add(…)` names in `show.ts`, which would have
      caught it. Four pins, all four failing on the old pages.
348.  DONE (2026-09-16, the next three guides: task-dependencies,
      dev-tasks, environment-variables). environment-variables reads
      true — both `ExecEnv` fields, the essential allowlist its own pin
      already holds to `ESSENTIAL_ENV`, and the remote rule that
      `define` and `inputs.env` cross while `passThrough` does not.
      task-dependencies said a failed task "aborts its transitive
      dependents"; in vx's own vocabulary it SKIPS them (`skipped` is a
      counted status of its own, `aborted` is what a run's teardown
      sets on `Ctrl-C`), and the sentence never named the three
      `--continue` modes that decide it. dev-tasks said vx SIGTERMs a
      dependency server and "waits for it to exit" — unbounded, where
      `SIGNAL_SHUTDOWN_GRACE_MS` gives it two seconds and then
      SIGKILLs, which is the guarantee that matters to anyone whose
      server traps the signal. Two pins, both failing on the old pages.
349.  DONE (2026-09-16, the last three guides: plugins, extensibility,
      lockfiles — the guide queue is read out). A CORRECTION of item
      346 first: it fixed remote-caching's "three-call `RemoteCacheLayer`
      seam" and never grepped the class, so the same sentence sat on
      extensibility, plugins and `architecture.md` (whose site copy is
      generated). All three now name `hasMany` beside `has`/`get`/`put`,
      and the pin is the grep item 346 owed: every hand-authored page
      that mentions `RemoteCacheLayer` is refused the words "three-call"
      (STATUS, which quotes the old wording, and the generated copies
      are skipped by name and by their generated mark). The plugins
      guide's own roster named `@vzn/vx-schedule-history` on `schedule`
      alone where it fills three — `schedule`, `admit` and `commands`
      (`vx history`) — the same omission item 343 fixed on
      pipeline-with-seams, and extensibility's `commands` row said
      "nothing unless declared" with two shipped verbs in the repo. Its
      hook block, though, names all thirteen `PLUGIN_HOOKS` and is
      pinned as a control (by set, not order: the block groups by kind
      on purpose). lockfiles named five of the six keys the pnpm
      parser folds into every project's digest
      (`ignoredOptionalDependencies` missing). Four pins, three failing
      on the old pages.
350.  DONE (2026-09-16, the site's last unread corner: the two
      `concepts/` pages and the two `migrate/` guides — every
      hand-authored page on the site has now been read against source
      once). A SECOND correction of the same kind as 349's: item 348
      fixed "a failed task aborts its transitive dependents" on
      task-dependencies and did not grep the class, so the
      how-vx-works concept still said it. Both pins are now the greps
      the two items owed — no hand-authored page may say a failed task
      aborts its dependents (the class), and none may call the remote
      seam three-call (349's). how-vx-works also said the scheduler
      "walks the graph in topological order" where it takes the ready
      task with the most transitive dependents off a heap, and
      SIGTERMed persistent tasks with no word of the two-second grace.
      The two migrate guides read true and are the better halves of
      the posts item 342 corrected: from-turborepo's table carries
      `outputLogs` and all three globals (which the post lacked), and
      from-nx expands `@nx/vite:*` into the four commands
      `KNOWN_EXECUTORS` maps — now pinned to them. Two pins, one
      failing on the old page, one a control.
351.  DONE (2026-09-16, the READMEs — the root one and the nine
      package ones, the prose this series had never read). A THIRD
      round of the same lesson, on two classes at once. Item 346
      struck the CI guide's "roughly 10–21%" for `--frozen` and did
      not grep: the root README still sold "~120 ms back per 1,000
      packages", where the 2026-09-12 head-to-head is a tie (177 ms
      plain against 165). Item 345 struck "about a hundred lines" from
      the MCP guide and post: `packages/vx-mcp/README.md` said it too,
      of a 144-line `server.ts`. Both are fixed, the MCP pin now takes
      all three pages, and the frozen claim has a class pin of its own:
      no page may attach a millisecond or percentage figure to a
      `--frozen` or `vx lock` paragraph unless benchmarks.md carries
      that figure. The root README's headline numbers are NOT drift and
      were left alone: the block between its `bench:start` / `bench:end`
      markers is rendered from `results.json` by
      `packages/vx-bench/update-site.ts` (its own rounding, the same
      committed run), which is why it reads 35 s where benchmarks.md
      reads 34.61s. The other eight package READMEs carry no claim of
      either class. Two pins, both failing on the old files. A
      correction of the handoff below: the loop holds 333–351, not past
      the forty-item trim line, so no trim is due yet.
352.  DONE (2026-09-16, the module pages whose source has moved since
      they were read). Only two of the fifty-odd pages are older than
      their source, and one is a false positive worth recording: the
      2026-09-16 change under `cache.md` is a comment REFLOW —
      identical text, rewrapped — so the page is current. The other is
      `config.md`, whose source moved by item 347's own edit. But the
      grep that finds the class found a FIFTH instance of it:
      `modules/config-schema.md` said the validator types
      "`resources` are cores and megabytes", and
      `workspace/config-schema.ts` contains the word zero times. Item
      347 fixed four pages and did not read the module docs; 351 found
      two more classes in the READMEs. So this item's pin is the class
      itself — the schema must not declare `resources`, the validator
      must not mention it, and no hand-authored page may describe it as
      a field (design/ and history/, which record its removal, are
      exempt, as are the generated site copies). That makes five class
      pins in four items. One pin, failing on the old page.
353.  DONE (2026-09-16, flows.md and patterns.md — the two pages #451
      read, and the pins it left them). patterns.md's citations hold:
      its pin takes every `src/x.ts` ("phrase") pair and refuses a line
      number, and all of them resolve. flows.md had NO pin at all, and
      names an owner per flow in the same shape that rotted on
      patterns.md — `module/file.ts`, sometimes with the symbol
      (`cache/cache.ts:prune`). All fourteen resolve today; they are
      pinned now, files and symbols, line numbers refused, so the next
      split fails the suite instead of orphaning a citation quietly.
      The read itself found a SIXTH instance of a class this session
      fixed one page at a time: flows.md said the watch filter drops
      "editor swap files", the wording item 338 struck from the
      watch-mode post, where `IGNORED_SUFFIXES` is `.tsbuildinfo` and a
      trailing `~`. Item 338's pin now takes both pages. Three pins,
      one failing on the old page; the citation pair are controls
      whose worth is what they catch next.
354.  DONE (2026-09-16, comparison.md and parity.md — the pages I had
      been CITING as ground truth all session without reading).
      parity.md holds: its 45 deep-pin test paths all resolve, and the
      Turbo and Nx versions it names are the ones its two suites cite,
      both already pinned in `doc-references.unsafe.test.ts`.
      comparison.md's config table is what found the fault, and the
      fault is a MISS OF MINE from item 348: the task-dependencies
      guide says wildcards and negation "are **not** allowed in
      `dependsOn`", and comparison.md says `'build.*'` and `'^build.*'`
      are task-name patterns that ARE. `task-graph.ts` sides with
      comparison: a partial pattern expands over the project's task
      names (Nx 19.5 parity, zero matches legal, never itself); only a
      BARE `*`/`^*`, a negation, and a pattern in the `pkg#task` form
      are refused, each with its own `UserError`. Item 348 read that
      sentence and verified only its second half — that
      `cache.inputs.tasks` accepts the filter forms — and let the first
      half stand, which is the "assert the exact expected set" rule
      going unapplied. The guide now states both halves, pinned to the
      three refusal messages, the expansion branch, and
      comparison.md's own wording so the two pages cannot disagree
      again. One pin, failing on the old page.
355.  DONE (2026-09-16, architecture.md — 660 lines, the page item 349
      edited without reading). Its two big list claims hold: the module
      table's shapes are right (`config` the one single file, the other
      seven `dir + index.ts`), and the orchestrator's file inventory
      names 44 of the 45 files in `src/orchestrator`, the only absence
      being `index.ts`, which the page calls the contract elsewhere.
      Both were held by nothing, and a table of forty filenames is a
      snapshot the moment a file lands beside it, so the inventory is
      pinned now: every file on disk but the index must be named, and
      every name must exist. The one fault is a count — "its files fall
      into five layers" above a SIX-row table. Worth recording how it
      hid: a grep for "five layers" returns nothing, because the phrase
      wraps ("five\nlayers"), which is this repo's own
      negative-grep rule (item 304) catching me from the other side. The
      layer count is pinned to the table's own rows now, in words, so it
      tracks the table. Two pins, one failing on the old page.

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
6. DONE 2026-09-16 as item 226: the site's introduction has a
   "Known limits" section — Bun ≥ 1.4 for source installs (the binary
   needs nothing); Linux sandboxing needs `bubblewrap`, `socat` and
   `ripgrep` (the third named 2026-09-16, item 246) and cannot run as
   root inside a container; Windows is WSL; macOS
   violation reporting is lossy under load (In-flight 5); the remote
   seam moves whole artifacts in memory (Next 2, fine below ~100 MiB);
   a task's replayed output is its first and last 8 MiB (229); a project
   inside a submodule is enumerated by its own repository (221). An
   article links it.

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
   item 285 (2026-09-16, a tie; 274 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) `vx lock` reads config files raw on purpose,
   and the doctor, the selector and watch fall back to a raw per-file
   read only when the staged load throws (five call sites by
   2026-09-16, each read and confirmed against a `turbo()` workspace:
   `vx info` counts the plugin's tasks) — grep for `loadProjectConfig(`
   before adding a consumer that is not a fallback; (d) was "`logger.ts` and
   `framed-output.ts` are the last large files" — by 2026-09-16 they are
   699 and 518 lines and the largest are `cache/cache.ts` 1,583,
   `cli/watch.ts` 1,121, `orchestrator/run.ts` 1,040 and
   `exec/sandbox-runtime.ts` 1,034, each one concern (the split of
   cache.ts is item 8's), so the note is closed; (e) REFUTED: a discovery memo keyed on directory and
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
14. The handoffs after items 153, 130, 166, 170, 176, 183, 189, 192,
    197, 202, 208, 211, 214, 221, 225, 230, 236, 240, 242, 252, 263,
    270, 275, 281, 287, 293, 299, 305, 312, 319 and 326 (14–14ad) are
    in `docs/history/2026-09-status-next-log.md`; 14ae below is the
    current one.

14ae. **Handoff after item 332 (2026-09-16, late night).** Six items
since 14ad, and the oldest-page queue is exhausted: 327 (util-hash,
util-ulid, version), 328 (bin, chained-cache, config), 329
(fingerprint, lockfile-claim, task-log-buffer), 330 (the five util
pages), 331 (package-graph, projects, timing), 332 (config-schema,
index, plugin, plugin-host, plugins, util-cgroup). Every module page
under `docs/modules/` has now been read against its source once in
this series (306–332), and the 09-16 pages the day's own items wrote
are current by construction. The finds of this stretch: a façade page
that described the surface of a month ago (thirty names gone, twenty
missing), a transitive closure described as the DFS a 2026-09-09
profile replaced, a timing page naming a third of its labels, a host
page with a `vx init` hint the host no longer raises, an every-export
pin that reads the file (`config.ts`, `projects.ts`, `plugin-host.ts`,
`index.ts` by column) and a tests list pinned to a suite's `it` names.
`tests/module-shape-drift.test.ts` holds seventy-three shapes, its
constants, samples, error sets, export lists, the timing labels and
the façade. 326 went in #472, 327 #473, 328 #474, 329 #475, 330 #476,
all merged; 331 is #477 (open) and 332 stacks on it. Open: Next 1, 2
and 16, gated by their own terms; In-flight 5 (macOS); the owner
residue — the `NPM_TOKEN` secret, the release cut, the site's address.
No open issues. The loop holds 306–332; the next trim moves them to
history. The box: the pages that drifted furthest were the ones that
describe a LIST the code owns (exports, labels, tests, hooks) — a list
in prose is a snapshot, and the pin is what makes it a mirror; a page
that reads true (plugin, plugins, four of five util pages) is still
read, since the series' worth is the coverage, not the find count.
Methods that paid: the same three-pages-per-item cadence; deriving a
list pin from the source's own regularity (`mark('…')`, `it('…')`,
`export {…} from`) rather than from the page. Next: the trim (306–332
to `docs/history/`, this handoff's summary in their place); then the
site pages under `packages/vx-docs/src/content/docs/` by the same
oldest-page queue, guides first (each already has sample pins from
297–305, so the read is prose); then Next 6's re-measure only when
warm-path code moves (none did today). Never end with "what next?".

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

19. DONE 2026-09-16 as item 216, as a per-RUN lock (the per-task grain is a refinement, see 216). Was: **A per-task lock for two runs on one workspace (from item 215).**
    Two vx processes that clean and restore the same output tree race;
    today the loser fails plainly ("was interrupted … another vx run").
    A per-task advisory lock (`flock` on `<cacheDir>/locks/<taskId>`,
    taken around clean + restore or execute, released with the task)
    would make the second run wait for the first and then see its
    outputs current. Cost to measure before shipping: one open + flock
    per task on the warm path (expected microseconds against a 0.2 ms
    task floor), and what a waiting run prints (the admit-held line's
    shape, item 171). Not started.

20. DONE 2026-09-16 as item 229 — the retained copy is bounded (8 MiB head + 8 MiB tail, the middle named). Was: **A task's captured output has no cap.** Measured 2026-09-16
    (item 225's probe): a task printing 200 MB costs vx 620 MB of RSS
    on the miss AND on every hit (the string, its encodings, the row),
    and its stdout lands in `cache.db` whole — 193 MB of `.vx/cache`
    beside an 18 KB `tar.zst` that holds the same bytes compressed —
    since the replay reads the row, not the archive. A realistic chatty
    suite is 5–20 MB (62 MB of RSS, a 20 MB row), so this is an
    outlier's cost today. When it is not: bound what a task's capture
    RETAINS (chunks, a head and a tail, the dropped middle counted and
    said in the replay — `[vx] … 180 MB of output not kept`), store
    the same bounded text once, and measure RSS per chatty task before
    and after. Not started; the number that decides is a real
    workspace whose logs pass ~50 MB per task.

21. DONE 2026-09-16 as item 239 — refused before the evaluation, the install named. Was: **A config's bare import that no `node_modules` can serve reaches
    the npm registry before it fails.** Bun auto-installs a package a
    module cannot resolve when no `node_modules` exists above it —
    measured 2026-09-16: sixteen connections to the registry and 150 ms
    before "cannot find", and a sandbox violation on the macOS job; with
    a `node_modules` present, 0 connections and 1 ms; `bun --no-install`
    stops it too. A fresh clone before its install, or a typo in an
    import, should be refused by vx before evaluation: `config-imports`
    already lists a config's specifiers, so a bare one with no
    `node_modules/<name>` above the config is a `UserError` naming the
    install, never an import. Not started; the pin is a config importing
    a name no `node_modules` serves, evaluated with no network.

## Decisions (this arc)

- **`--affected` includes dependents (2026-09-16).** The sugar is
  `--filter '...[<base>]'`: the changed projects and everything that
  depends on them, the superset a CI gate needs and what the guides
  promised; `--filter '[<base>]'` is the changed-only form for "test
  what I touched". Item 287.
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
