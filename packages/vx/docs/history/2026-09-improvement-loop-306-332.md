# Shipped, 2026-09 — improvement-loop items 306–332

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`; items 333–352 in
`2026-09-improvement-loop-333-352.md`; items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 373–392 in
`2026-09-improvement-loop-373-392.md`; items 393–412 in
`2026-09-improvement-loop-393-412.md`; items 413 onward continue in
`docs/STATUS.md`. The handoffs written alongside these items (14z–14ad)
are in `2026-09-status-next-log.md`.

306.  DONE (2026-09-16, the trim 14aa named): items 282–305 moved
      whole to `docs/history/2026-09-improvement-loop-282-305.md` and
      handoffs 14w–14y to `docs/history/2026-09-status-next-log.md`,
      the record paragraph and every earlier history head repointed,
      each removed line checked present in its new file before the
      write. The loop holds this entry; 14z and 14aa stay as the
      current handoffs.
307.  DONE (2026-09-16, 14aa's named next: the module pages' "Public
      surface" blocks against their modules). A probe over the 68
      pages that have one (247 names) found four stale: config-imports
      documented `scanLocalImports`, a function the module has not
      exported since the channel was rewritten (its real surface is
      `unprovidedBareImports` and `configImportOwners`);
      execute-task still declared the hash trio that moved to
      `task-hash.ts`; stable-keys listed two internal helpers as
      public; task-graph declared `ProjectEntry`, which the workspace
      module owns. Fixed, and the law is `tests/module-surface-drift.test.ts`:
      the index maps each page to its files, and every name a block
      declares must be exported there (a bullet may name a member).
      Fails on the old pages.
308.  DONE (2026-09-16, comparison.md's flag map against the parser):
      the vx column held; the callout under it still named the
      retired `--excludeDependencies`, and one cell wrote `--timeout`'s
      value as a duration (it takes milliseconds). Pinned beside the
      table pin: every flag the section's vx cells and callouts name
      is a parser flag. Fails on the old page.
309.  DONE (2026-09-16, comparison.md's gap audit and running list
      read against source): the audit's "verified present in core"
      still listed `prune` (removed 2026-09-11) and `migrate` (its own
      package since 2026-09-10); the "shipped since" pipeline bullet
      named five of thirteen hooks (pinned to `PLUGIN_HOOKS` now,
      beside the tables); the daemon rejection quoted a 240 ms warm
      1000-project run the benchmarks page has at 172 ms. The
      shipped/rejected/out-of-scope lists otherwise read true.
310.  DONE (2026-09-16, `optimizations.md` read against source): the
      catalog cited `execute-task.ts` for the hashing rows (three of
      them; it is `task-hash.ts` since item 16), `execute-task.ts` for
      the git-snapshot invalidation (`miss-save.ts` and
      `hit-restore.ts`), a `cache/remote-cache.ts` that does not exist,
      `layered-cache.ts` for `Bun.Glob` (zero uses; `inputs.ts`), and
      "the CLAUDE.md decision log" (retired 2026-09-02); two "known
      headroom" entries had shipped — the batched all-hits probe
      (#17d) and the per-run `taskConfigHash` memo (#5). Every
      citation is module-qualified now and the pin in
      `tests/doc-references.test.ts` holds each `module/file.ts:symbol`
      to an existing file and symbol, and refuses a bare basename.
      Fails on the old page.
311.  DONE (2026-09-16, item 304 re-read against `wire.ts`): 304
      removed the remote-execution guide's "retry once at 64 KB"
      bullet as a Bun 1.3 leftover. It is live code: `writeResource`
      catches a `DEADLINE_EXCEEDED` on a multi-message write and
      retries once at `SAFE_CHUNK_BYTES` (65535), because the Bun
      http2 flow-control defect is a race above the RFC 7540 initial
      window, not a boundary. A grep for `retry` missed `retries`
      and called it gone. The bullet is back, stating the trigger and
      the size, and pinned in `tests/site-samples.unsafe.test.ts` to
      `CHUNK_BYTES` and `SAFE_CHUNK_BYTES` read from the wire's
      source; 304's record and 14aa are corrected in place, and
      CLAUDE.md has the rule: grep every form of the word and the
      constant's name before calling a documented behaviour gone.
      Also fixed in passing: a code span in CLAUDE.md wrapped across a
      continuation line (the root is outside `lint.oxfmt`'s scan, which
      runs in `packages/vx`, so nothing caught it). Fails on the page
      304 left.
312.  DONE (2026-09-16, the three site pages the series had not read:
      quickstart, add-to-existing-repo, parity). The quickstart's hit
      comment showed a glyph no source file prints (the row is glyph,
      time, status, cache, name: a local hit opens with the local
      arrow and reads "success local") and called `--graph` "text or
      Graphviz DOT" (DOT only, as `vx help` says); the adoption page
      gave the concurrency default as the raw core count (the help
      says the cores this process may use — a cgroup quota caps it);
      parity's "Reading the map" still counted changed-not-dependents
      among the divergences (#446 closed it) and pointed
      cleaned-not-additive at the section that does not record it.
      `docs/modules/framed-output.md`'s two one-liner samples showed
      the same invented shape. Fixed; pinned: the quickstart glyph and
      words are `formatTaskHitLine`'s and the flag comments are the
      help's (`tests/site-samples.unsafe.test.ts`); every `tests/` and
      `packages/` deep pin parity cites exists and its Turbo/Nx
      versions are the suites' (`tests/doc-references.unsafe.test.ts`);
      the one-liners' shape and the module page's samples
      (`tests/framed-output.test.ts`, which had never called either).
      Five fail on the old pages.
313.  DONE (2026-09-16, 14ab's named next: the module pages whose
      source moved after the page, widest gap first — plan-format,
      run-report, events). plan-format.md's text sample had a
      "no-cache — opts out" row the formatter words "(would exec)",
      a group row the text form hides, and a four-task plan summed
      as three; its placement sample padded a column the formatter
      does not; its JSON sample put `description` before `hash`; its
      DOT sample was a document the formatter never wrote (another
      graph name, a Helvetica node default, status words for labels,
      a different green); and none of the `predicted:` footer, the
      `download:` block or the wire's optional fields was on the page.
      The module's own docblock joined the summary with a colon and
      printed one decimal (a comma, two). events.md still sent
      `WireEvent` to "serve delegation, dev sockets" (569dd17 removed
      both; nothing in core consumes it) and had "Web/TUI/MCP
      surfaces" on the bus (`@vzn/vx-mcp` reads history), and named
      none of the outcome vocabulary or the wire views it exports.
      run-report.md read true (its five commits since were label
      changes the page never quoted). Fixed; pinned: every sample on
      plan-format.md is the formatter on one fixture
      (`tests/plan-format.test.ts`, four fail on the old page); the
      names events.md now declares are held by the surface law.
314.  DONE (2026-09-16, the next three module pages by gap: cli-cache,
      inputs, scheduler). cli-cache.md said the verb hard-codes
      `.vx/cache` and has no `--dry-run` — it resolves the directory
      a run would use (`--cache-dir`, `cacheDir`, a `config` plugin)
      and has had the flag since 2608ed4; its regex was the lowercase
      one, its `PruneArgs` three of five fields, its test bullet a
      `--older-than 0s` the verb now refuses. inputs.md described a
      `Bun.Glob` fallback walker and an `ignore` library that no
      longer exist (git or a `UserError`), four always-ignored globs
      of six, `ResolveInputsArgs` six of eleven fields, hashing in a
      `cache.ts:hashFiles` that is `file-hashes.ts`, and none of the
      literal-is-a-tree rule, the gitignored-literal refusal, the
      nested-repository enumeration, the symlink containment guard or
      the emptied-directory sweep. scheduler.md's `TaskOutcome` had
      twelve of twenty-three fields, `ScheduleOptions` none of
      `continueMode`, `settledOf`, `admit`, and `mergePriorities` was
      unnamed. Fixed, and the law is `tests/module-shape-drift.test.ts`:
      a page's interface block lists exactly the source's top-level
      fields (five shapes), and a quoted constant or regex is the
      source's (`ALWAYS_IGNORE`, both parsers). Seven fail on the old
      pages. The surface law holds names; this holds the fields
      beneath them — the same law one level down.
315.  DONE (2026-09-16, the next three module pages by gap:
      task-hash, prepare, metrics). task-hash.md's surface block had
      two interfaces as one-line comments and no `describeTaskInputs`,
      `TaskInputComponent` or `captureInto` — the components `vx why`
      diffs — and its Tests section sent the reader to the
      plan-format tests instead of `tests/task-hash.test.ts` and
      `tests/task-hash-derive.test.ts`; the key's parts now name the
      `key` stage's plugin parts, the forwarded args and the group
      expansion. prepare.md's `PreparedRun` had ten of nineteen fields,
      step 1 named a `loadWorkspaceConfig` the step no longer calls
      (the config arrives evaluated from `cli/workspace-config.ts`),
      and step 4 said "no layer at all is a named error" where the
      local store is the floor (`resolveCache`), and named neither the
      writable check nor the two-digest fingerprint. metrics.md listed
      seven signatures of eight (`latestRunId`, ffbea3b) and claimed
      the flakiness verdict is imported (it is not; only
      `KEYED_RUNS_SQL` is). Fixed; the shape law gains three shapes
      and one export-list pin (metrics' block names every exported
      function and the count word matches). Four fail on the old
      pages.
316.  DONE (2026-09-16, the next three module pages by gap: cli-help,
      summary, cli-run). cli-help.md listed seven of the help text's
      thirteen sections and said "tests don't validate this against
      the parser" (`tests/cli-doc-drift.test.ts` has since item 300).
      summary.md's surface lacked `SummaryStats`, the section
      formatter and the Aborted and Skipped sections, and its Tests
      claimed a failed-id list capped at five that the test beside it
      says is never printed; the footer sample itself rendered true
      (four cached successes with the page's context) and is pinned
      now. cli-run.md's `RunArgs` had fifteen of twenty-five fields,
      its `--affected` sugar was the changed-only `[<base>]` (#446
      made it `...[<base>]`), its verbose-summary sample showed
      `cache` and `ok` where the column is `outcomeLabel`
      (`restored-local`, `success`), and "`--verbosity 2+` is
      reserved" described nothing (any value above 0 prints the
      table). Fixed; the shape law gains `RunArgs`, `SummaryStats`,
      `RunContext` and a sections pin (cli-help.md's list is the help
      text's headers, in order); the footer sample is
      `tests/summary.test.ts`'s. Three fail on the old pages.
317.  DONE (2026-09-16, the next three module pages by gap: filter,
      env, deferred-outputs). filter.md's grammar said `*` never
      crosses `/` (it is pnpm's rule: the sole metacharacter, any
      characters, so `*core*` reaches through `@scope/`), had no path
      glob (`./apps/*`, `{apps/**}` over the root-relative dir,
      3daacd8), sent the `[<since>]` resolution to `cli/run.ts` (it is
      `cli/select.ts`), lacked `pathGlob`, `pathRoot` and `onNoMatch`,
      and claimed "the prefix wins" for `...pattern^...` (both flags
      apply). env.md said vx does not touch `PATH` two sections below
      the paragraph that says it prepends the project's bin, and
      named neither run marker (`VX_RUN_WORKSPACE`, `VX_RUN_TASK`,
      what a nested `vx run` reads to refuse). deferred-outputs.md's
      surface was prose with no shapes and no `size`. Fixed; the
      shape law gains five shapes and env.md's two allowlist
      paragraphs are `ESSENTIAL_ENV` split where Windows begins. Four
      fail on the old pages.
318.  DONE (2026-09-16, the next three module pages by gap: migration,
      remote-prefetch, history). migration.md's `ApplyMigrationArgs`
      lacked `format` (`--mjs`, 1501a62) and `GeneratedProject` was a
      comment; the single-project report that names the packages a
      missing `workspaces` field never reaches (3add62b) was
      undocumented. remote-prefetch.md said the prefetch is "gated on
      `cache instanceof LayeredCache`" — it is gated on the policy's
      `remoteRead` axis, probes existence in one batch
      (`remoteHasMany`, marking the absent so the lazy path skips
      them too) and pumps `concurrency` fetches; the page had no
      shape. history.md had no surface block at all (`TaskHistory`,
      `HistoryProvider`, the two providers, the window's default of
      50). Fixed; the shape law gains six shapes and the window
      default. And the law's own parser was wrong twice today: it
      stripped `//` before `/*`, so a docblock quoting a line comment
      ate the block's close (`GeneratedTask` read as two fields), and
      the reverse order let a `/*` inside a line comment open a
      phantom block (`ParsedFilter` read as twelve) — it now takes
      whichever opener comes first. Five fail on the old pages.
319.  DONE (2026-09-16, the next three module pages by gap:
      run-context, telemetry-host, config-cache). run-context.md said
      the git context costs "ONE `git rev-parse` spawn" — it reads
      `HEAD` from the `.git` files first (a linked worktree's
      `gitdir:`, a symbolic or detached HEAD, loose and packed refs)
      and spawns only on an unfamiliar layout; it named three of six
      exports (no `captureDefaultBranch` ladder, no workspace
      identity, no `normalizeRemoteUrl`) and two CI providers of five.
      telemetry-host.md's signature lacked `extraSinks` and the sink
      check (0130aec: an off-contract sink is refused with its shape
      named). config-cache.md's impurity list lacked `constructor` and
      `localeCompare` (b100ed3), the page had no surface block, and
      the warm fast path never mentioned `hashFiles` (ac8cc32: every
      indexed closure identified in one call). Fixed; the shape law
      gains five shapes, the CI matrix and the impurity list (parsed
      from `IMPURE_RE` itself). Seven fail on the old pages.
320.  DONE (2026-09-16, the gap list's tail begins: placement,
      hit-restore, miss-save). placement.md's surface was a sketch
      with no types and said a persistent task is pinned local — it
      is not placed at all (`placeTasks` skips it with the groups; the
      pin is its dependants'). hit-restore.md's shape held; the three
      commits since (a hit with no outputs touches no artifact, the
      directory snapshot taken at run end, the producing execution's
      usage on the outcome) are on the page now. miss-save.md's
      `SaveMissArgs` lacked `cpuMs` and `peakRssBytes` (db5e61c) and
      gave `deferSave` and `saveMiss` return types the code does not
      have (the lane's callback returns the landing promise; the save
      returns `{ landed }`, which the prose two paragraphs down
      already described). Fixed; the shape law gains four shapes,
      `RestoreHitArgs` among them as a control that passes both
      ways. Three fail on the old pages.
321.  DONE (2026-09-16, the gap list's tail: options, lockfile,
      plugin-commands). options.md's `RunOptions` was a comment naming
      twelve of twenty-nine fields — no `bus`, `inflight`,
      `telemetrySinks`, `remoteCache`, `download`, `flow`, `frozen`,
      `timeout`, `continueMode`, `tags`, `command`, `outputLogs`; the
      block is the interface now, each embedder field with its
      meaning. lockfile.md had no surface (`LockfileEntry`,
      `Lockfile`, the constants, `frozenProjectConfig`'s refusal), and
      never said the CLI's selection load reads the lock under
      `--frozen` too (b5a5854). plugin-commands.md said a verb the
      workspace cannot answer is `null` — a workspace file that fails
      to load answers `{ loadError }`, said beside "unknown command",
      never instead of it — and lacked `pluginVerbs` (262662c, what
      `vx completions` reads). Fixed; the shape law gains six shapes,
      its field-count guard now admits a one-field interface. Five
      fail on the old pages.
322.  DONE (2026-09-16, the gap list's tail: admission,
      sandbox-request, git-inputs). admission.md's shape held; its
      "the barrier is released in a `finally`" was true and
      incomplete — since 4c2b254 the `finally` lifts the barrier on
      the save lane's landing promise, or a joiner would probe a miss
      and run the task again (the page says so now).
      sandbox-request.md's surface was commentary in place of
      shapes (`SandboxArmer`, `SandboxRequest`, `Placeholder`) and
      did not say that a throw from the runtime itself is the same
      one-line verdict as a refused probe (2bcfbcd). git-inputs.md's
      block gave `applyGitEnumeration(cache, enumeration)` where the
      signature is five arguments in another order, elided every
      other signature and all of `GitFilesCache`'s methods, and never
      said what a missing `git` is (6adfb6c: one refusal line, never
      a stack) or when the spawn is scoped to the run's projects
      (at most 64, none the root). Fixed; the shape law gains five
      shapes and reads a `readonly` field as a field. Four fail on
      the old pages.
323.  DONE (2026-09-16, the gap list's last four: upgrade, cli-watch,
      util-errors, logger — the probe's queue is empty). upgrade.md
      had no surface and nothing on the unreachable-host line
      (832c349). cli-watch.md's surface named `watchCmd` alone of
      fifteen exports, its flag table still passed
      `--excludeDependencies` through (retired), its picker pointer
      went to `cli/run.ts`, and its Tests section named one of eight
      suites. util-errors.md's surface was `UserError` alone (no
      `isUserError`, none of the refusal helpers or hints, 2bcfbcd's
      `isTmpdirRefusal`) and said `bin.ts` tests `instanceof` (it
      consults `isUserError`, as the page's own later section says).
      logger.md's `Logger.runStart` info had one field of five,
      `OutputView` and `resolveOutputView` lacked `hash-only`, the
      mode list lacked it too, and the status line was "a single
      bottom line" with a format nothing prints — it is a region:
      persistent rows, one row per worker slot, an overflow line and
      the live summary section. Fixed; the shape law gains three
      shapes (`OutputView` a control). Two fail on the old pages.
324.  DONE (2026-09-16, the pages the gap probe cannot see, oldest
      first: cli-format, colors, dependency-spec — all last touched
      2026-09-05). cli-format.md's byte table rendered true; its use
      sites lacked `vx last` (peak RSS) and the re-export a plugin
      verb reads. colors.md read true; the empty-color dim path and
      the per-color memo are on the page now. dependency-spec.md
      said the task graph "rejects wildcards and negation" — it
      rejects the BARE wildcards, negation and a pattern in the
      `pkg#task` form, and accepts a partial pattern (`build.*`,
      `^build.*`) as a namespace of tasks to add (Nx 19.5 parity; the
      page predated `isTaskPattern` / `compileTaskPattern` and
      `tests/wildcard-depends.test.ts`). Pinned: the byte table is
      `formatBytes` row for row, the parser's five errors are the
      page's, and two colour shapes — every one a control that
      passes both ways, since the finds were prose: the first item
      in this series with no differential, and the first from the
      oldest end of the list. Sixty-odd shapes and samples now hold
      the module pages.
325.  DONE (2026-09-16, the next three oldest pages: download-policy,
      local-shortcircuit, nested-dirs). download-policy.md read true
      but for `toplevel`'s eager set (a requested OR surfaced task)
      and had no shapes. local-shortcircuit.md's gate said "NEVER
      LayeredCache … ≥1 dep edge" — `shouldShortCircuit` tests the
      layer's `hasRemote` flag, `localRead`, and at least one NODE;
      its surface was two bullets. nested-dirs.md described an O(n²)
      walk the module replaced with a sort and a forward scan (near
      O(P log P)), skipping the interloper siblings (`foo-utils`
      beside `foo`) that a plain break once let hide `foo/nested`;
      its Tests section missed `tests/nested-dirs.test.ts`, and its
      symlink note described a walker the module no longer feeds.
      Fixed; the shape law gains three shapes and the `DownloadMode`
      union. Four fail on the old pages.
326.  DONE (2026-09-16, the next three oldest pages: plan, tally,
      upstream). plan.md's `PlannedTask` had four fields of seven,
      `RunPlan` one of four, `PlanArgs` seven of thirteen, no
      `PlanPrediction`; its algorithm probed `cache.get` and its Side
      effects section said the probe bumps `accessed_at` — the
      planner calls `cache.has`, a presence check that bumps nothing
      (the fact 302 pinned on the site was wrong on the module page
      too); the history step, the placement label and the download
      mode were absent. tally.md's `Tally` had six fields of ten (no
      restored/up-to-date split, no `aborted`), and the rules did not
      say an aborted task is outside `total`; `tallyViews` was
      unnamed. upstream.md's pattern table lacked the task patterns
      (`build.*`, `^check.*`, a package pattern in `pkg#name`) that
      `nameMatcher` accepts. Fixed; the shape law gains six shapes.
      Six fail on the old pages.
327.  DONE (2026-09-16, the last three 09-05 pages: util-hash,
      util-ulid, version). util-hash.md said "no dedicated unit file"
      — `tests/util-hash.test.ts` pins the published XXH3 vectors,
      the `0n` seed and the 16-char rendering. util-ulid.md
      described, in full, a hand-rolled 26-character Crockford-base32
      ULID with a `now` parameter: `ulid()` has been
      `Bun.randomUUIDv7()` (36 characters, RFC 9562) since the
      module's own header comment says so, and the page's Tests
      section listed assertions the suite does not make. version.md's
      "if versioning ever derives from `package.json`" describes what
      the file already does (a JSON import, inlined under
      `bun build --compile`). Fixed; the pin renders `ulid()` and
      holds the page to its width and shape. One fails on the old
      page.
328.  DONE (2026-09-16, the first three 09-10 pages: bin,
      chained-cache, config). bin.md's "Behavior" was a twelve-line
      code sketch claiming "actual file matches this shape": it
      tested `instanceof UserError` (the file consults `isUserError`),
      exited without ending stdout (the flush 175 added), printed no
      file-system refusal, and had no `error` listeners (the EPIPE
      fix); its Tests section said no test drives the file where the
      end-to-end suites spawn it. chained-cache.md read true and
      gains its class shape. config.md's surface named nine exports
      of eighteen — none of `Plugin`, `PLUGIN_HOOKS`, `PLUGIN_PACKAGE`
      or the three sandbox types — gave `defineProject` its old
      signature (it is `const T` with `dependsOn` typed against the
      project's own task names), said the task-config digest is
      `sha256` (xxh3), that `tsc -b` checks types at build time (there
      is no build; the gate's `oxlint --type-check` does), and sent a
      new field through `orchestrator.ts:executeTask` (a file that
      does not exist). Fixed; the pin holds config.md's block to every
      export of `src/config.ts`. One fails on the old page.
329.  DONE (2026-09-16, the next three 09-10 pages: fingerprint,
      lockfile-claim, task-log-buffer). fingerprint.md's surface had
      neither `WORKSPACE_FINGERPRINT_FILES` nor `WorkspaceFingerprints`,
      sent the project `package.json` digest to `execute-task.md` (it
      is `task-hash.md`'s since item 16), and never said why
      `vx.workspace.*` is deliberately not folded (the module's own
      comment does: it is placement, storage and observability, and
      folding it would split the cache between a laptop and a CI
      runner declaring different plugins). lockfile-claim.md named the
      same package twice as two claimants, gave the options as an
      inline object without `part` (the key part's name `vx why`
      shows; default `deps`) and the hooks without their types.
      task-log-buffer.md lacked `TaskLogEntry` and `TaskLogBundle`.
      Fixed; the shape law gains six shapes and the fingerprint file
      table, in order. Six fail on the old pages.
330.  DONE (2026-09-16, the five 09-10 util pages: edit-distance, num,
      paths, settle, tail). Four read true against their modules —
      the first item of the series with a majority of true pages.
      util-paths.md's Tests section said the helpers are exercised
      only transitively; `tests/util-paths.test.ts` and three suites
      drive them directly. util-tail.md gave `Tail` as a comment.
      Fixed; the shape law gains `Tail` and one pin over the six
      constants these pages quote (`MAX_TIMEOUT_MS`,
      `PERSISTENT_TAIL_CHARS`, the log buffer's three, the settle
      default), each held to its declaration line — controls today,
      the tripwire for the day a cap moves. One fails on the old
      page.
331.  DONE (2026-09-16, the three 09-11 pages: package-graph,
      projects, timing). package-graph.md described the transitive
      closures as memoised DFS built with the graph; they are bitset
      closures swept in Kahn order, built on the first query (the
      2026-09-09 profile), with the per-query fallback for a cycle and
      the reason it is not a memoised recursion. Its Tests list was a
      paraphrase of nine where the suite has thirteen — now the `it`
      names, pinned in order. projects.md lacked
      `loadResolvedProjects` (the embedder's read: `vx mcp`, the
      schedule-history plugin) and said `vx show` passes no lock (it
      passes the lock under `--frozen`, through
      `cli/workspace-config.ts`). timing.md listed a third of the
      marks and four of twenty-one spans, `history` for
      `record history`; the page now lists every label, and the law
      holds the marks to `prepare.ts` + `run.ts` in order and the
      spans to every `span(` call under `src/`. Exports of
      `projects.ts` join config's every-export pin; three more
      shapes. Four pins fail on the old pages.
332.  DONE (2026-09-16, the six 09-12 pages: config-schema, index,
      plugin, plugin-host, plugins, util-cgroup — the oldest-page
      queue's last). index.md's group table was the façade of
      2026-08: thirty names that left it on 2026-09-10 (the graph
      primitives, the hashing seam, the event bus, the history
      readers) and none of the twenty that arrived (`definePlugin`,
      `PLUGIN_HOOKS`, `collectInfo`, the machine pair, the migration
      seam, the lockfile shell, `TaskLogBuffer`, `exitSignal`), "~80
      exports" for a runtime set of 42, four plugin packages of
      seven, and a release story (`gh release create` bumps
      `VERSION`) where `npm.yml` stamps the manifest `version.ts`
      imports. Rewritten from the file, values and types apart, and
      the law holds both columns to it, the count in prose too.
      plugin-host.md listed `resolveExecutors` twice with an `opts`
      neither it nor `resolveCache` takes, an `opts.workspaceFile`
      `vx init` hint the host no longer raises, a sink-isolation
      invariant that is the telemetry host's, and none of `hasHook`,
      `CACHE_LAYER_METHODS`, `fingerprintClaims`, `claimedAffected`;
      the section now names every export and the law holds it.
      config-schema.md's `where` is `configPath`; util-cgroup.md's
      readers gain the doctor. plugin.md and plugins.md read true
      (the hook table was pinned in 283). Three pins fail on the old
      pages. Handoff 14ae.
