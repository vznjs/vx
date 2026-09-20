# Shipped, 2026-09 — improvement-loop items 333–352

The record `docs/STATUS.md` carried until 2026-09-19, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`; items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 373–392 in
`2026-09-improvement-loop-373-392.md`; items 393–412 in
`2026-09-improvement-loop-393-412.md`; items 413 onward continue in
`docs/STATUS.md`.

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
341.  DONE (2026-09-19, the next three oldest posts: the bitsets /
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
342.  DONE (2026-09-19, the three adoption pages: honest-benchmarks,
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
343.  DONE (2026-09-19, the three internals posts: pipeline-with-seams,
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
344.  DONE (2026-09-19, config-in-typescript — the last post outside
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
345.  DONE (2026-09-19, the three oldest site guides: mcp, otel-bridge,
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
346.  DONE (2026-09-19, the next three guides: ci, workspace-config,
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
347.  DONE (2026-09-19, the next three guides: caching, tasks,
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
348.  DONE (2026-09-19, the next three guides: task-dependencies,
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
349.  DONE (2026-09-19, the last three guides: plugins, extensibility,
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
350.  DONE (2026-09-19, the site's last unread corner: the two
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
351.  DONE (2026-09-19, the READMEs — the root one and the nine
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
352.  DONE (2026-09-19, the module pages whose source has moved since
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
