# Shipped, 2026-09 — improvement-loop items 373–392

The record `docs/STATUS.md` carried until 2026-09-20, moved here whole
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
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`, items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 393–412 in
`2026-09-improvement-loop-393-412.md`; items 413 onward continue in
`docs/STATUS.md`.

373.  DONE (2026-09-19, the trim this arc generated work for and
      never paid). The loop stood at exactly forty entries, 333–372,
      which is the line the record paragraph names, so items 333–352
      moved whole to
      `docs/history/2026-09-improvement-loop-333-352.md` and the loop
      keeps 353–372. A PREFIX, not the middle: the formatter renumbers
      an ordered list sequentially, so cutting from the middle would
      have renumbered every entry below the cut and silently broken
      every cross-reference in this file and in the test comments that
      cite item numbers. Taking the oldest twenty leaves the list
      contiguous from 353 and the formatter has nothing to change.
      Eight history heads and the record paragraph repointed, per the
      convention item 306 set. The edit script asserted everything
      before it wrote anything and refused twice before it ran — once
      on a pointer whose wrapping differs per file, once because a
      history head never lists ITSELF, so the file named before the
      onward clause is not the same in every head. Both refusals left
      the tree clean, which is the rule about half-done trees working
      as intended rather than being re-learned. Counted before cutting
      and after: twenty out, twenty left, twenty in the new file.
      Recorded as the close of this arc rather than a find: the last
      six items were one motion, and the yield had turned from the
      repo's errors to my own.
374.  DONE (2026-09-19, a test that raced the clock it was asserting
      about, found by CI on the docs-only PR above). The macOS
      core-test job went red on `output-dirs.test.ts`: "a directory
      modified within the racy window is not snapshotted at all" got
      four rows where it expected none. Not the diff — a docs-only
      change cannot reach `recordOutputDirs` — and not a flake to
      re-run: the test wrote `dist/fresh/x.js` and called
      `recordOutputDirs`, and the guard it was asserting
      (`output-index.ts`: drop the whole snapshot if any directory's
      mtime is newer than `Date.now() - OUTPUT_DIRS_RACY_MS`) reads
      its clock INSIDE that call, so "the directory was modified
      within the window" held only while the test beat 50 ms to it.
      The loaded runner did not: its own fixture writes were 67 ms
      apart in the failure output. Reproduced here by inserting that
      delay — same four rows, same mtimes — which is the repro this
      kind of failure needs before it is called a race. The fix states
      the premise instead of racing for it: stamp `dist` and
      `dist/fresh` with `utimesSync` to the FAR edge of the window
      (`now + OUTPUT_DIRS_RACY_MS`, so the assertion survives a
      scheduling delay between the stamp and that clock read), and
      stamp the tree old again for the second half instead of sleeping
      past the window. Differential both ways: without the guard the
      test fails, and the other fourteen pass under both arms.
      The same window had quietly emptied its neighbours. A `symlinkSync`
      into `dist/` bumps `dist`, so the snapshot in the symlink test
      was REFUSED and `not.toContain('dist/link')` had been passing on
      an empty set — proven by deleting the new `age()` call and
      watching the added `toContain('dist/sub')` control fail. Same
      for the 8,193-directory cap case, where the window and the cap
      both yield `[]`. So the fixture no longer sleeps `RACY_MS + 10`
      to age itself; an `age()` helper stamps every directory old
      (symlinks left alone, as the walk leaves them), which is
      deterministic, faster, and one fewer claim about time in a file
      that had three.
375.  DONE (2026-09-19, the site guides begin — three pages, and a
      documented knob wired to nothing). The module-page series
      (306–332) exhausted `docs/modules/`; handoff 14ae names the site
      pages under `packages/vx-docs/src/content/docs/` as what follows,
      guides first, by the same oldest-page queue and the same three
      per item. The three oldest by last touch: `otel-bridge.md`,
      `running-tasks.md`, `environment-variables.md`.
      Two read true, and both were already held where they enumerate
      something: the allowlist in `environment-variables.md` is one of
      the four copies item 359 pinned, and every flag, mode and example
      in `running-tasks.md` is what `help.ts` and the parsers say,
      `--max-size 5gb` included (`parseSize`'s regex takes the `B` and
      the case). Their remote-execution and recursion-guard claims
      check out in `vx-reapi`'s `commandEnvironment` and in
      `run.ts`'s nested-run refusal.
      The otel guide cost three finds. (1) `timeoutMs` was a DEAD
      OPTION: resolved from the option, defaulted to 15000, carried on
      `OtelSinkConfig`, stored on the sink — and read by nobody, while
      the POST aborted on a literal `15_000`. `otel({ timeoutMs: 1000 })`
      waited fifteen seconds on a hanging collector, which the new test
      measures at 15003 ms without the fix and ~100 ms with it. The
      default POST takes the configured value now.
      (2) `taskSpanAttributes`' docblock described a per-file
      fingerprint map "up to 500 path/hash pairs" and a `tree` field a
      collector may truncate. No such attribute exists, in that package
      or in core's `TaskTelemetry` — a vx-cloud-era claim the code
      lacks, struck for what is true (nothing on that span is
      unbounded; the tail travels as a log record that carries its own
      length).
      (3) The losslessness tripwire had only one of its two halves.
      `Required<TaskTelemetry>` makes a new field a type error in the
      fixture, but the key pin next to it covers `RunContextRecord`
      only — so the fix for that type error was to add the field to the
      fixture and stop. Probed: a `probeField` added to the interface
      and the fixture rode nothing and all 41 tests passed. The task
      half is pinned now, and this is the half the additive fields keep
      landing in (`where`, `outputs`, `attempts`, `blockedBy`,
      `timedOut`, `sandboxViolations`, `notReady` all arrived that way).
      Also pinned: every `OtelPluginOptions` field but the test seam
      has a row in the guide's table — proven both ways, a dropped row
      and an added option. The table was already complete; a pin on a
      list the code owns is the method this series settled on, not a
      find.
      The gate earned its keep twice more. `bun test` passed a
      `server.stop(true)` that `lint.oxlint` refused as a floating
      promise — and awaiting it hung the test forever, because a
      `Bun.serve` handler that never settles makes `stop(true)` never
      resolve either. The handler is released in `finally` now; probed
      both ways under `bwrap --unshare-net`, which is where the task
      runs (152 ms released, a 30 s timeout pending). That same lint
      run named a dead `MIN_BUN` import in `doctor.ts`, left by item
      367's design churn: only the comment beside it still uses the
      name. Core's own lint names its files and had not seen it; the
      plugin's, which reads the symlinked core, did.
      Recorded, not fixed: `output-memory.test.ts`'s
      `long - short < 64` MiB failed the gate at 76 under twelve
      parallel shards and passes 4/4 three times in isolation — the
      second time this file has done that (item 365 was the first),
      and out of reach of this diff. Loosening it is the wrong move
      and the comment above it says why: the measured UNBOUNDED
      figures are 651/488 MiB at 6 s against 280/370 at 2 s, so the
      `\r` arm grows ~30 MiB/s and this test's 1 s → 3 s gap would
      show only ~59 MiB unbounded. A 128 MiB slack would stop
      catching the very regression it is for. What the arm needs is a
      wider duration gap or a measured noise floor, not a bigger
      number; a Next item when someone takes it.
376.  DONE (2026-09-19, three site guides, all true, and one promise
      nobody had proven). `trusting-the-cache.md`,
      `remote-execution.md` and `why-vx-is-fast.md` — the next three
      oldest after 375's.
      All three read true against source, and each is already pinned
      where it enumerates or quotes: the `vx why` verdict sentences
      and console labels, the wire chunk sizes
      (`CHUNK_BYTES` 128 KB, `SAFE_CHUNK_BYTES` 65535, a 30 s call
      deadline, `/bin/sh -c`, the UNAVAILABLE / RESOURCE_EXHAUSTED
      retry set — all read and confirmed), and the benchmark figures
      the fast page quotes (3m 46s / 5m 13s / 34m 44s and 8 / 88 /
      1,712 ms per package, which reconcile with the 8.45 s overhead
      line; 74 ms and 172 ms; 8.5 s → ms; 16–25 ms per 1,000 configs).
      The find is a BEHAVIOURAL promise, not a list. `vx why` says of
      itself, in its own header and in the guide, that it is read-only
      over `cache.db` — no config evaluation, no re-hash — and the
      guide sells the consequence: safe to run anywhere, including on
      a machine that just cloned the cache. Stated in three places,
      proven in none. It is now an e2e with both arms and both
      controls: a project config rewritten to `throw` changes nothing
      `vx why` prints, while `vx run` in the same workspace trips on
      it (the control that says the sabotage is real); and with
      `--cache-dir` a throwing `vx.workspace.mjs` changes nothing
      either, while the same command WITHOUT the flag fails — which
      pins the guide's one stated exception, that the workspace file
      is evaluated once to find the cache directory. Differential: a
      `loadCliProjects` call added to `why.ts` turns the first arm red.
      A note for whoever continues this series: git last-touch does
      NOT advance for a page that reads true, so the queue re-offers
      it forever. The pages read so far, in order: otel-bridge,
      running-tasks, environment-variables (375), then
      trusting-the-cache, remote-execution, why-vx-is-fast (376).
      Next three by that queue: `mcp.md`, `sandboxing.md`,
      `caching.md`.
377.  DONE (2026-09-19, three guides true, and the drift a page's own
      SOURCE was carrying). `mcp.md`, `sandboxing.md`, `caching.md`.
      All three read true — the six MCP tools and their table, the
      nine sandbox grants and the three Linux binaries, the
      always-excluded list, `inputs.tasks` (`[]` none, omitted all),
      the 510 ms / 760 ms / 3.59 s warm row. The finds are all one
      step behind the page.
      `@vzn/vx-mcp`'s own header said "four READ-ONLY tools" of SIX,
      "three methods" while the dispatch has always answered `ping`
      too, and "server.ts is ~100 lines" of 144. That last one is the
      lesson: a pin already holds that sentence in the guide, the blog
      post and the package README — three separate passes (items 339,
      345, 351) each found one more copy — and this FOURTH copy
      survived all three because it spells it `~100` where the pin's
      regex asks for `about N lines`. That is the negative-grep rule
      of item 304, this time inside the pin. The regex takes both
      spellings now, and the header is the fifth arm of that loop.
      The count and the method list are pinned in the package, beside
      the pin that took the tool NAMES out of that header after they
      drifted into advertising a `runTasks` tool that never existed.
      That repair left the number, and the number drifted the same
      way; the header states neither now, and `listTools()` is where
      both live. Every case the dispatch answers must be named there.
      `tools.test.ts`'s own header still described the architecture
      that was replaced: it said the transport is NOT ours, that
      `src/cli/mcp.ts` hands framing to the SDK's
      `StdioServerTransport`. There is no SDK (the package's only
      dependencies are `@types/bun` and `@vzn/vx`), no
      `src/cli/mcp.ts`, and `server.ts` owns the framing down to one
      streaming `TextDecoder` — which is what the framing tests
      directly below that paragraph exist to prove. Corrected, and the
      class greped: two more `src/cli/mcp.ts` references in the same
      file now read as the history they are. The 2026-06 architecture
      review keeps its mention: no live page cites it, so it is a
      record (item 372's rule).
      The sandboxing guide is the same one-copy-of-two: the pin over
      the nine `SandboxGrants` keys, the `allow`/`deny`/`ignore` trio
      and the three Linux binaries covered only the BLOG POST, while
      the guide lists all of it. Both pages now, as one `describe.each`
      — proven by dropping `machLookup` from the guide — and a page
      that COUNTS the binaries has its count checked, since the post
      says "three binaries" beside the list.
378.  DONE (2026-09-19, a ladder missing a rung, and the same
      one-copy-of-two twice more). `ci.md`, `remote-caching.md`,
      `workspace-config.md`.
      The find: the workspace-config guide's `timeout` precedence read
      "a task's own `exec.timeout`, then the `VX_TASK_TIMEOUT` env
      var, then this" — THREE rungs of four, and the one it dropped is
      `--timeout`, the rung a user actually types. It sits ABOVE the
      env var, so the page did not merely omit it: a reader would have
      concluded the env var wins over the flag. Every other copy has
      it right (`schema.md` twice, `cli.md`, `options.ts`, `run.ts`,
      `execute-task.ts` and `options-resolve.test.ts`'s header, which
      pins the BEHAVIOUR of all four rungs). The pages were held by
      nothing; a class pin now reads the ladder off the one expression
      that resolves it and requires every hand-authored page naming
      `VX_TASK_TIMEOUT` to name all four. Proven by putting the old
      sentence back.
      Two lists were the unpinned half of a pinned pair, the same
      shape as 377's sandbox grants. The flaky-task footer is rendered
      in `ci.md` exactly as in the blog post, and only the post was
      held to `formatFlakySection`; both are now, proven by changing
      `3×` to `4×`. And `remote-caching.md` said "four mature server
      implementations" — it had said six, while naming four
      (NativeLink, BuildBuddy, Buildbarn, bazel-remote). Corrected and
      deliberately NOT pinned: how many REAPI servers exist in the
      world is not a fact this repo owns, and a test over it would
      pin marketing copy.
      Everything else checked out: the `vx-reapi-v1\0` action-digest
      prefix, the 128 KB chunk and the Bun floor, `RunOptions.remoteCache`,
      the four `RemoteCacheLayer` methods (pinned), the `--affected`
      messages (`has no base here`, `HEAD itself` and the
      nothing-affected note), the `--frozen` figures (pinned), the
      job-summary block
      (pinned), and `vx.workspace.{ts,mts,js,mjs}` against
      `project-loader.ts`'s list.
      Read so far: otel-bridge, running-tasks, environment-variables
      (375); trusting-the-cache, remote-execution, why-vx-is-fast
      (376); mcp, sandboxing, caching (377); ci, remote-caching,
      workspace-config (378). Next three: `tasks.md`, `dev-tasks.md`,
      `extensibility.md`.
379.  DONE (2026-09-19, a table two hooks short, and a field the guide
      called inert). `tasks.md`, `dev-tasks.md`, `extensibility.md`.
      `dev-tasks.md` reads true throughout: the 2 s SIGTERM grace
      (pinned), the loader's refusal of `cache` on a persistent task,
      the trailing-partial-line match in `runner.ts`, the
      `localBinding` port bridge.
      `extensibility.md`'s stage table listed ELEVEN of the thirteen
      `PLUGIN_HOOKS` — `setup` and `teardown` were absent, and the
      guide names them nowhere else, so a plugin author reading the
      table of what a plugin can hook would not know they exist. This
      is precisely the defect item 343 found in the
      pipeline-with-seams POST (`admit` nowhere, `teardown` riding in
      `setup`'s row) and pinned there, and only there. Both tables now,
      one `describe.each` over a row reader that takes the FIRST
      backticked identifier per row — the post leads with the hook, the
      guide leads with a stage word and spells the hook with its
      parameters, and both pages name plugins in later columns.
      The third one-copy-of-two in three items.
      `tasks.md` presented `description` as "optional metadata shown in
      the interactive picker and `--dry` output" — two sections above a
      careful accounting of which `exec` fields the key folds and which
      it strips. A reader of the guide alone takes it for inert. It is
      not: the key hashes the WHOLE resolved task config and strips
      only `exec.remote`, so a cosmetic edit costs a re-run. `schema.md`
      says exactly that and is now the pin's other arm; the guide says
      it too. Pinned beside it: the projection really does strip one
      field, so the page's "the one `exec` field stripped from the key"
      cannot go quietly wrong in the direction that produces stale
      hits.
380.  DONE (2026-09-19, a paragraph two keys short, and two pins whose
      REACH was the defect). `lockfiles.md`, `plugins.md`,
      `how-vx-works.md`. The last reads true — the workspace-root
      markers against `workspace.ts`, the two-second kill grace, the
      most-blocked-first heap.
      `lockfiles.md` describes the install-wide material twice, once
      per parser. The pnpm paragraph lists all six keys and is pinned;
      the BUN paragraph listed three of six, leaving out
      `lockfileVersion` and `configVersion`, so the two read as if bun
      folded less than pnpm. Both are pinned now, one `describe.each`
      over a regex that takes `stable({…})` or `JSON.stringify({…})`.
      The pin's first draft searched the WHOLE PAGE for each key,
      which let the pnpm paragraph's `lockfileVersion` cover for the
      bun paragraph's missing one — the loose-selector failure of item
      377's `about N lines` regex, caught this time by trying the
      differential that mattered rather than the one that was easy.
      Each arm reads its own manager's paragraph now, and dropping
      `lockfileVersion` from the bun one is red.
      Two pins were narrower than the class they name. The
      `VxPlugin` interface block in `plugins.md` is the THIRD copy of
      the hook list after the post's table and the extensibility
      guide's; it is held to `PLUGIN_HOOKS` as a SET, since it groups
      by category rather than by pipeline order. And the path check
      (`doc-references.test.ts`) walks `packages/vx/docs` only, so a
      `src/…` or `tests/…` path named on a SITE page was checked by
      nothing — the tree where item 377 found a header still citing
      `src/cli/mcp.ts` a release after the verb left core. Nothing is
      stale there today; the tripwire is the point.
      Read so far: 375's three, 376's, 377's, 378's, 379's, and
      lockfiles, plugins, how-vx-works (380). That is fifteen of the
      nineteen guide and concept pages. Left: `task-dependencies.md`,
      plus the three top-level hand-authored pages
      (`introduction.md`, `quickstart.md`, `add-to-existing-repo.md`)
      and the two under `migrate/`.
381.  DONE (2026-09-19, the fix from 379 had a third copy, and my own
      widening was the thing that missed it). `task-dependencies.md`,
      `introduction.md`, `quickstart.md`, `add-to-existing-repo.md` —
      the guides and concepts are read through.
      Item 379 found `extensibility.md`'s stage table missing `setup`
      and `teardown`, fixed it, and widened the post's pin to cover
      both pages. It did NOT grep the class, which is the rule that
      exists for exactly this: `introduction.md` carries a THIRD copy
      of that table, with the same two hooks missing. Fixed, and the
      pin no longer LISTS its pages — it finds every hand-authored
      site page whose text holds a `| Stage` table, asserts the set,
      and holds each to `PLUGIN_HOOKS` in order. A fourth copy fails
      it until someone decides what it says.
      Same treatment for the sandbox binaries, pinned on two pages by
      377: `introduction.md` names them too, in the LONG spelling
      only, so a pin asking for `bwrap` would have read it as absent.
      Discovered now, with either spelling accepted per binary, and
      the discovery takes a page that names TWO or more — one
      in passing ("wraps the command in `bwrap` or seatbelt", the
      one-command-per-task post) is not making the claim and is not
      held to it. Both widenings proven by putting the old text back.
      A comment de-claimed: the group-task check says a task with no
      `exec` "must declare something to depend on, otherwise the task
      is a literal no-op ... almost certainly a config mistake", while
      only an ABSENT `dependsOn` is refused and the EMPTY one is
      documented — `build: { dependsOn: [] }` is how a package
      consumed as source says it has nothing to build. The behaviour
      was already pinned (`project-loader.test.ts`); only the comment
      was out of step.
      Everything else read true: the three `dependsOn` forms and all
      three refusals (bare wildcard, negation, a pattern in the
      `pkg#task` form), the `^` bridge, the status words, the
      quickstart's `satisfies` scaffold and its ~17 ms, the
      introduction's 8 MiB replay bound.
382.  DONE (2026-09-19, the migrate pages — and the site's
      hand-authored set is read through). `migrate/from-turborepo.md`
      and `migrate/from-nx.md`. Both tabulate what the MAPPER knows,
      and in both cases only the matching BLOG POST was pinned: the
      fourth and fifth instances of the one-copy-of-two in six items.
      The turbo guide's mapping table listed eight of the nine
      `KNOWN_TASK_KEYS`, and the one missing was `extends` — the key a
      PER-PACKAGE `turbo.json` uses, so the row a reader migrating a
      package-level override goes looking for. The prose mentions it in
      passing ("the root pipeline and any per-package `extends`"); the
      table, which is what anyone scans, did not. Added with what the
      mapper does (`extends: false` alone opts the package out; any
      other key replaces the root's definition rather than inheriting
      it) and both tables are one `it.each` now, each naming its own
      end-of-table heading.
      The Nx guide's executor list needed a different shape, and that
      is the point worth keeping: the POST names all eight
      `KNOWN_EXECUTORS` ids and counts them; the GUIDE collapses the
      vite family to `@nx/vite:*` and names the four COMMANDS instead,
      which is accurate and reads better. Pinning it to the post's
      shape would have forced a rewrite that makes the page worse, so
      it is held to "id OR command" — a ninth executor still has to
      appear in one of the two. A pin should hold the claim the page
      makes, not the shape another page made it in.
      That closes the hand-authored site pages outside the blog:
      nineteen guides and concepts, three top-level pages, two migrate
      pages. The blog is thirty-one posts and every one of them was
      pinned in the 297–305 arc; a read of that shelf is the next
      oldest-page queue if someone wants one.
383.  DONE (2026-09-19, the CONTRACT pages, and three numbers that
      were not what they claimed). `docs/README.md`,
      `docs/patterns.md`, `docs/comparison.md` — the three least
      recently touched of the twelve top-level pages the site imports
      verbatim. The module series (306–332) read `docs/modules/`; the
      pages beside it had not been read as a series.
      (1) `patterns.md`'s performance table is the 476-package /
      1,428-node run, and the sentence above it called it the
      3,270-task one and cited `packages/vx-bench/RESULTS.md`, which
      `benchmarks.md` says IS the 3,270-task run — two wrong
      attributions in one sentence, made easy to believe because that
      run's baseline critical path (1m 40s) is also this table's cold
      figure. The 3,270-task numbers are 3m 46s / 510 ms / 777 ms,
      nothing like the ones printed.
      (2) `README.md`'s headline said a 100-project warm run is
      79 ms. That is the WAVE 2 column of `benchmarks.md`'s row; the
      floor is 74 ms, which `why-vx-is-fast.md` quotes. A pin asking
      "is this number on benchmarks.md?" passes it, because it is —
      in the wrong column. The pin reads the LAST column of the row.
      (3) `comparison.md` contradicted itself: item 7 of its
      Likely-worth-adding list records `--output-logs hash-only` as
      SHIPPED (2026-08-25) and its flag map lists all four modes,
      while the "Shipped since this list was first drawn" bullet
      listed three. Pinned to the set `run.ts` accepts.
      The table pin is ROW-wise, not figure-wise: the three cells
      after a runner's name must appear together on one
      `benchmarks.md` row, so a figure cannot drift onto the wrong
      runner. It passed the mis-attributed table, correctly — the
      figures were right and only the lead-in was wrong — so the
      lead-in is pinned too, against the package count `benchmarks.md`
      states above the matching row. All three proven both ways.
      The rest of `patterns.md` holds: every cited symbol resolves
      (`CacheKeyInput`, `taskConfigHash`, `runPersistent`, `binPaths`,
      `cleanOutputs`, `extractArtifactStream`), and its phrase-to-file
      pin is real. Not pinned, deliberately: how many REAPI servers
      exist, and which pages ENUMERATE `--output-logs` versus mention
      it — a selector for that would be contrived, and a contrived
      selector is the `about N lines` regex again.
384.  DONE (2026-09-19, three contract pages that read true, and a
      path class nothing checked). `comparison.md` in full (595 lines,
      spot-read in 383), `parity.md`, `optimizations.md`.
      All three hold. `comparison.md`'s CLI flag map is what
      `run.ts` and `index.ts` accept, `-h` and `--report-file`
      included; its gap list's shipped claims check out
      (`RunOptions.remoteCache`, the `--continue` modes, the
      `pkg#pattern` refusal, `--cache-dir`, `vx last` over
      `metrics.ts`); and its Bun-native list is real down to
      `Bun.YAML` in `workspace.ts` and the content-hash import bust in
      `project-loader.ts`. `parity.md`'s ≠ on `--filter` + `--affected`
      being a UNION is pinned by `filter.test.ts`'s "combined includes
      union". `optimizations.md` is held by its own file-and-symbol
      pin.
      The find is a REACH gap, one directory up from 380's. The path
      checks resolve `src/…`, `tests/…` and `docs/…` against
      `packages/vx`, so a citation written with a `packages/…` prefix
      is seen by neither — and the contract docs carry seven (the
      bench scripts, `RESULTS.md`, `results.json`, `REPOS.md`, a
      vx-migrate test). All seven resolve today; the pin is the
      tripwire.
      Its first draft flagged two more, and they were not citations:
      `config-imports.md` walks a reader through
      `packages/lib/preset.mjs`, a workspace that does not exist. That
      is the contrived-selector failure of 377 and 380 a THIRD time,
      and the tell is mechanical — a path under a package directory
      that exists is a citation, one under a package that does not is
      an illustration. The pin tells them apart and says so.
385.  DONE (2026-09-19, two steps of the key derivation in the wrong
      order). `caching.md` — the stale-hit-critical contract, and the
      page CLAUDE.md's worst-failure-class rule points at.
      Its § Cache key derivation is a numbered list that SAYS it
      describes the parts "in order", and the composition is a SEED
      CHAIN (`xxh3(part, prevDigest)`): swap two parts and the digest
      changes. Steps 11 and 12 were inverted against the fold. The
      code folds `plugin:` between `upstream:` and `inputs:`; the page
      put the input files at 11 and the plugin material at 12 — while
      that step's own TEXT said "folded after the upstream keys",
      which is right, so the prose and its own numbering disagreed.
      Anyone re-deriving a key from this page — a plugin author
      checking their material lands, a future refactor — would have
      produced a different one.
      Swapped, with "and BEFORE the input files" added to the
      sentence that was already half right, and pinned: the labelled
      folds are read from `key()` in source order
      (`task`, `workspace`, `pkg`, `config`, `forward-args`,
      `env-values`, `runtime-values`, `ws-runtime-values`, `upstream`,
      `plugin`, `inputs`) and each numbered step must be the next one,
      with step 1 the unlabelled `CACHE_VERSION`. A twelfth part
      cannot be folded without a documented step. Proven by putting
      the inversion back — it fails on `plugin`.
      The rest of the page holds. Its "What's NOT in the key" list is
      exactly right, including the `exec.timeout` / `exec.retries`
      asymmetry it flags as easy to misread, and its step 5 says
      `description` is folded — the fact the tasks GUIDE omitted until
      item 379. The fingerprint list, the invalidation table, both
      version constants and the SQLite schema were already pinned.
386.  DONE (2026-09-19, the other half of the schema contract, and my
      naive selector for the fourth time). `schema.md`, the config
      contract. Its § TaskConfig documents every field the loader
      accepts — checked set by set against `config-schema.ts`'s
      `assertKnownFields` lists, all eleven of them, and nothing is
      missing.
      What was missing is the PIN. The page's validation-error table
      is driven by the table itself (a row without a case that
      provokes it fails), and the plugins bullet is held to
      `PLUGIN_HOOKS` — both cover what the loader REFUSES. Nothing
      covered what it ACCEPTS, so a field added to any set could ship
      as a config key users cannot discover. Pinned now, and the pin
      states its own reach: "the name appears on the page" is
      trivially true for a short generic name (`env`, `files`) and
      decisive for a new one (`weakerNetworkIsolation`,
      `workspaceRuntime`), which is the drift it is for. Proven by
      adding an `undocumentedKnob` to `CACHE_OUTPUT_FIELDS`.
      The first draft searched for each name in BACKTICKS alone and
      reported four false gaps — `env` twice, `workspaceRuntime`,
      `weakerNetworkIsolation` — because the page writes them
      qualified (`exec.env`, `cache.inputs.env`). That is the
      naive-selector failure of 377, 380 and 384 a FOURTH time, and
      the tell is always the same: the differential that matters (does
      a real new field fail?) was never the one the first draft ran.
387.  DONE (2026-09-19, `cli.md` — the last large contract page —
      and two findings of different kinds). Read against source: the
      exit ladder, `VX_KILL_GRACE_MS` and its two-second default, the
      moved verbs' pointers, the report's status and cache
      vocabularies, the glyph grid, the worker-row cap, the 30 ms
      redraw floor, the GHA group and error commands, prune's units
      and its one-hour orphan grace — all of them hold.
      Two do not. First, a SWALLOWED LIST ITEM: the four-step cache
      precedence under § Cache control rendered as three steps plus a
      run-on sentence, because a paragraph written into the blank line
      after step 3 left step 4 nowhere to start and the formatter
      joined it on. The page then read `--force` as part of a remark
      about remote layers. This is the reflow damage the parenthesis
      pin catches in its other shape, so the pin is a sibling of that
      one and it is a CLASS: two design docs carried the same break
      (`architecture-review-2026-06` and `-07`, where a whole phase
      plan ran inline). The selector only counts a number that follows
      sentence punctuation, which is what tells a pulled-up marker
      from a citation (`— item 206. The session`).
      Second, the façade named `planRun` and withheld `RunPlan` and
      `PlannedTask`, while § Programmatic API listed all three engine
      functions as the surface an embedder builds on — and `run` and
      `prepareRun` both had their return types exported from the
      start. An embedder that cannot NAME a return type cannot hold
      it. Exported, and pinned by discovery: every async engine
      function the façade re-exports must export what it returns, so
      the next one added is held without an edit. Rule 3 could never
      have caught this — it pins the RUNTIME export set, and a type is
      not one.
      The selector went naive twice more here and both were caught by
      running the check, not by reading it: the first read only whole
      `export type {…}` clauses and reported `collectInfo → InfoFacts`
      missing when the line above exports it inline, and the second
      flagged `loadResolvedProjects → Map` as an unexported type.
388.  DONE (2026-09-19, `execution.md` + `flows.md`, three findings,
      one of them a unit). The rest of both pages holds: the 16-hex
      key, the `CacheKeyInput` field names, `CacheStatus`'s five
      words, the 8 MiB capture bounds, `VX_RUN_WORKSPACE` /
      `VX_RUN_TASK`, watch's 150 ms debounce and its ignore sets,
      every `<module>/<file>.ts` either page cites.
      First, the prepare timeline said the bulk git populate is ONE
      `git ls-files -s --others` plus one `git status`. It is four
      concurrent spawns (`ls-files -s -v -z`, `status --porcelain -z
-uall`, `rev-parse --show-prefix --git-dir`, a `core.*` config
      read), and `--others` is the flag it deliberately does NOT
      pass — `status -uall` answers untracked, and asking git again
      walked the same tree twice. The page could look right because
      `runGitLsFiles` still passes `--others`: it is the FALLBACK
      re-spawn for an invalidated partition, not the bulk path.
      Second, the `cache.key({…})` list read as the whole call and
      omitted `pluginParts` — the one argument a plugin author comes
      to that page for. Pinned against `CacheKeyInput` minus a named
      plumbing list, so a new field is a decision in the test.
      Third, and the one that matters most: `flows.md` dated the
      up-to-date check's fingerprint to "floor-to-second mtime".
      `output-index.ts` compares within one MILLISECOND and its own
      comment says legacy second-precision rows converge on their
      first restore — so the page described what the check stopped
      doing and overstated its tolerance a thousandfold.
      `caching.md` says **millisecond** twice: one copy pinned, the
      other drifted, the shape every finding in this arc has had.
      The class pin holds only a STATED precision (unqualified
      `(size, mode, mtime)` prose is left alone) and only rejects
      SECOND — and its first draft rejected the correct pages too,
      because `millisecond` CONTAINS `second`. Naive selector, fifth
      time, caught by running the check. Its sibling assertion then
      picked the site's caching GUIDE by basename; the contract page
      is selected by path now.
389.  DONE (2026-09-19, the drift was in the file every session reads
      first). `CLAUDE.md` § Stack named `Bun.Archive` a hard
      dependency. No `src/` file in any package calls it — the four
      mentions are comments, and `archive.ts`'s own header says it
      "used to do all three" before vx's streaming tar replaced it on
      2026-09-03, for the memory peaks (150 MiB restored at +644 MiB
      through `Bun.Archive`, +49 MiB streamed). The only live use is
      `archive-security.test.ts`, which runs it as an INDEPENDENT
      oracle against vx's own writer — a good use, and the opposite
      of a dependency.
      The same stale sentence rode two more copies: `architecture.md`
      and this suite's own Rule 6 comment both said core's floor is
      `Bun.Archive` and the answers that go wrong without it.
      `util/bun-version.ts` — the floor's own docblock, citing the
      same item 366 — names three wrong ANSWERS and not the archive:
      a 2 MiB `--format json` write truncated to 219 KB at the pipe,
      no `peakRssBytes` from the runner, a config syntax error
      arriving as a `BuildMessage` the classifier does not know.
      `caching.md` was right all along (§ Artifact container names
      the streaming code; the History records the move to
      `Bun.Archive` in v27 AND the move off it), which is the shape
      again: the contract page holds, the summaries drift.
      Pinned twice. Every Bun API the Stack sentence calls a hard
      dependency must appear OUTSIDE a comment somewhere under
      `packages/*/src`, and `Bun.Archive` must appear in none —
      discovered from the sentence, so a name added to it is held
      without an edit. And architecture.md's floor paragraph must
      name what `bun-version.ts` names, all three, and not the
      archive. Proven both ways.
390.  DONE (2026-09-19, `parity.md` — and the column that was pinned
      for the wrong property). Most of the page holds, and two probes
      refuted what I went looking for: every `tests/…` and
      `packages/…` path it cites resolves (already pinned), and all
      27 `` `page.md` § Section `` citations across `docs/` resolve
      too — the first run said fifteen were broken, which was my own
      selector reading markdown link syntax and keying a heading map
      by BASENAME, where `docs/cli.md` and `docs/modules/cli.md`
      collide. No finding there; recorded so the next reader does not
      re-run it.
      The finding is that the Deep-pin column's claim is not "this
      path exists" — it is "this suite pins the row", and two did
      not. `"cache": false` → `noCache: true` in `--summarize` cited
      `no-cache-word.test.ts`, which holds the WORD `no-cache` in the
      row, legend and report and never reads a summary file;
      `run-artifacts.test.ts` is where `noCache: true` is asserted
      (present only when true, the cached row byte-identical). And
      `nx reset` → `vx cache prune` cited `cache-hygiene.test.ts`,
      which is about an interrupted run publishing nothing and says
      `prune` nowhere; the prune pins are `cache.test.ts` (TTL, LRU,
      orphans) and `cli.test.ts` (`vx cache prune command`,
      `parsePruneArgs`).
      Pinned by deriving each row's token from the row itself where
      the vx cell names a flag or a config path, plus a named token
      for the two rows that name neither — which are exactly the two
      that were wrong. Two dotted paths the suites prove but never
      spell (`cache.inputs.files`, `exec.env.passThrough`) are
      RE-SPELLED rather than exempted: my first draft skipped them,
      and skipping a row's only token stops the check reading that
      row instead of passing it — the count fell from 14 to 12 and
      said so.
391.  DONE (2026-09-19, `benchmarks.md` — right everywhere, pinned
      nowhere). Checked the 3,270-task table figure by figure against
      the committed `packages/vx-bench/results.json`: five rows × three
      runners, all ten `(N×)` ratios, the baseline row, the three
      measured floors and the per-package overhead sentence. Every one
      agreed, to the digit — vx cold 226 449.85 ms as "3m 46s", Nx CPU
      6 846 039 ms as "114m 06s (197.8×)", vx's 8.45 s over the ideal
      schedule at 8 ms per package. The head-to-head heading's "46
      packages" is right too: `PACKAGES = (LAYERS - 1) * PER_LAYER + 1`,
      so `10 5 1` is 46 and not the 51 the prose suggests.
      So the item is the PIN, and it is worth more than a fix would
      have been: this is the only table in the docs backed by a
      committed data file, README and `patterns.md` quote onward from
      it, and every ratio on it is re-derived by hand. It compares
      NUMBERS, not spellings — each figure is parsed back to
      milliseconds and held to the granularity the page chose to print
      (`3m 46s` to the second, `510ms` to the millisecond). Formatting
      the file's numbers and diffing strings would only restate the
      formatter's assumptions, which is the pure-function trap the
      Rules already name. Four mutations prove it: a figure, a ratio, a
      floor and a per-package number each fail it.
      Two small things were wrong. The real-Nx section says "the same
      cleanup and arm logs as `turbo-repo.sh`" and never names
      `nx-repo.sh`, which is the harness that ran those reps — the
      Turbo section names its own script, so a reader reproducing the
      Nx numbers is sent to the wrong one. And `compare.ts`'s docblock
      describes the shape as "`layers` dependency layers, `perLayer`
      packages each, plus one `@bench/top`", which reads as 1101 at the
      defaults, two lines above its own correct 1090: the top layer
      REPLACES a layer rather than adding to one.
392.  DONE (2026-09-19, the module surface law, in the direction
      nothing held). `modules/README.md` says a Public surface block is
      "exported types + functions consumed by other modules", and
      "internal helpers are not part of the contract". Item 307's law
      checks one half — every name a block DECLARES is exported — so an
      export could ship and never reach its page, the same asymmetry
      item 386 found in `schema.md` (what the loader refuses was
      pinned, what it accepts was not).
      38 names across 11 pages were missing. The worst are the ones a
      reader goes to those pages FOR: `telemetry.md` listed four names
      and omitted `TelemetrySink` and `TelemetryContext`, the two types
      a telemetry plugin implements; `cache.md` omitted `CACHE_VERSION`
      and `SCHEMA_VERSION`, which CLAUDE.md's Live invariants quote,
      and the whole `CachePolicy` / `FULL_CACHE_POLICY` /
      `parseCachePolicy` trio behind `--cache`; `task-graph.md` omitted
      `expandRequested` and `unresolvedRequests`, which are what "every
      requested name must resolve" is made of. All documented now, each
      checked against its source.
      The pin is the reverse law, and "consumed by another module" is
      the convention's own wording so it is the test: an import or
      re-export of the name in a file whose module directory the page
      does not own. It carries a floor of 150 crossing names, so an
      empty result cannot come from a selector that found nothing to
      check — which is how the first two drafts of the probe failed.
      The first keyed "documented" on backticked names alone and so
      missed every page whose block is a fenced ts block, reporting
      that `orchestrator.md` omits `run`; the second counted any
      textual mention in another module as a consumer, comments
      included. Neither was reported as a finding, and the corrected
      run is where the 38 came from.
