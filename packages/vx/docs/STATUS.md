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
(handoffs 14z–14ad to the next-log file), and items 333–352 to
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, and
items 353–372 to
`docs/history/2026-09-improvement-loop-353-372.md` that night
(handoffs 14ae–14af to the next-log file), and items 373–392 to
`docs/history/2026-09-improvement-loop-373-392.md` on 2026-09-20
(handoff 14aj to the next-log file), so this file stays the handoff
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

393.  DONE (2026-09-19, `comparison.md` — the page handoff 14af
      flagged as the most drift-prone prose in the repo, and the one I
      had walked past). Two findings in its gap lists.
      First, a seam that no longer exists: items 2 and 5 said
      `--continue` and `--cache-dir` are "threaded over the wire".
      There is no wire — the whole-run `backend` seam went in 2026-08,
      and `run-report.ts` records its removal in its own docblock. The
      class holds: three other pages say "over the wire" and all three
      mean a real one (the remote-cache wire, MCP's JSON-RPC).
      Second, and worse, the config-evaluation purity GATE was
      described as opting a config out on "any `/` outside a comment".
      It refuses a BACKSLASH: `stripLiterals` removes literals and
      comments, and what survives must hold no identifier escape,
      because `\u0070rocess` IS `process` and no deny-list can see it.
      A forward slash is in every path literal and every division, so
      as written the gate excluded almost every config and the
      evaluation cache read as a feature that never applies.
      `modules/config-cache.md` has it right — backslash, identifier
      escape and all — and has been pinned since item 314. One copy
      pinned, the other drifts, for the twelfth time in this arc; the
      grep over the other nine pages that describe the gate found no
      third copy of the error.
      Pinned: the sentence's three conditions are read from
      `config-cache.ts` — the `\\` check, `PURE_PACKAGE` and
      `MAX_CLOSURE_FILES` — and a forward-slash escape claim fails it
      outright. Three mutations, one per condition.
      The flag map and § Where vx is ahead were read too and hold,
      including the group-task claim (no row, no tally, no `runs` row
      — `tally.ts` and `recordRunBundle` both skip them).

394.  DONE (2026-09-19, the trim the record paragraph's own rule
      called for). The loop stood at forty-one entries, 353–393, so
      items 353–372 moved whole to
      `docs/history/2026-09-improvement-loop-353-372.md` and the loop
      keeps 373–393. A PREFIX, as item 373 established: the formatter
      renumbers an ordered list sequentially, so a cut from the middle
      would renumber every entry below it and silently break every
      cross-reference in this file and in the test comments that cite
      item numbers. Nine history heads and the record paragraph
      repointed; handoffs 14ae–14af to the next-log file, 14ag written
      in their place. Counted before and after: twenty out, twenty-one
      left, twenty in the new file, and the new head does not list
      ITSELF (item 373's second refusal, honoured rather than
      re-learned).
      The edit script asserted all of it before writing any of it, and
      the probe behind it was wrong first: a literal single-line search
      for each head's onward clause matched NOTHING, because the
      pointers wrap. Had I trusted that, the conclusion would have been
      "no head needs repointing" and the chain would have shipped
      broken — the same naive-selector failure this arc met six times,
      here on the trim's own tooling. The corrected pattern allows
      `\s+` and found exactly one clause in each of the nine.

395.  DONE (2026-09-19, the blog's benchmark copies — right
      everywhere, and the pin took four tries to deserve trust). Read
      the three posts that quote the most figures, chosen by claim
      density rather than the bulk-commit mtime every post shares:
      `honest-benchmarks.md` (36), `why-vx-is-fast.md` (12),
      `no-daemon.md` (5). Every figure agrees — the 3,270-task table to
      the digit against `results.json`, the `(+0:08)` / `(+1:35)` /
      `(+31:06)` overheads to the second against the ideal schedule,
      and both solidjs/solid tables verbatim against `benchmarks.md`,
      ratios included. `no-daemon.md`'s `ls-files -s` + concurrent
      `git status` is a fair two-spawn summary of the four (item 388),
      and notably does NOT repeat the `--others` error the contract
      page had.
      So the item is the pin, and item 391 is why it matters now: that
      pin anchored `benchmarks.md` to `results.json` and left a SECOND
      full copy of the same rows unanchored in the blog — the exact
      configuration every finding in this arc came from.
      The pin took four corrections, each caught by running it. It was
      figure-wise first, and `66 ms` → `67 ms` passed because 67ms is
      the git-walk floor elsewhere on the page — item 383's row-wise
      lesson, re-learned. Row-wise then failed on the post's
      TRANSPOSED head-to-head (runner rows where benchmarks.md has
      runner columns), which cannot sit on one row by construction, so
      those three rows go to `results.json` directly. The figure
      pattern then allowed a space before `ms` but not before `s`, so
      it silently skipped every solid row — the floor assertion is what
      surfaced it, four rows checked where twelve were due, which is
      precisely what 14ag says a floor is for. And the granularity
      rule was a TOLERANCE, so `510ms` → `511ms` passed within one
      step; it now requires the page to show what rounding the
      measurement gives. Item 391's own arm had that looseness too and
      is tightened with it.
      PROSE is deliberately left alone, and that is a finding about the
      pin rather than the text: the posts round and convert on purpose
      — `0.76 s` for 760ms, `73 s` for 1m 13s, `35 s` for 34.61s — so
      an exact pin there would fail on correct writing. A table cell is
      a quotation; a sentence is a paraphrase.

396.  DONE (2026-09-19, the task-config hash: four copies, one
      right). `task-hash.ts` computes
      `xxh3hex(JSON.stringify(hashableConfig(cfg)))`, and
      `hashableConfig` drops `exec.remote` — placement is not key
      material, which is the whole point of the executor seam and what
      `task-hash-derive.test.ts` proves.
      `modules/config.md` had it, projection and rationale both.
      `caching.md` — the stale-hit-critical contract page — and
      `blog/resolved-config-hashing.md` both wrote
      `xxh3(JSON.stringify(node.config))`, which read literally puts
      `exec.remote` IN the key, the opposite of the design, and the
      blog post's own thesis is that everything in the object is in
      the key. `modules/execute-task.md` omitted the projection AND
      named `sha256` — a function core replaced with xxh3 for ~5× on
      the warm path (optimizations row 1) and which appears in no
      `src/` file; the only mention is `util/hash.ts`'s comment saying
      xxh3 BEATS it. Its next row claimed `sha256(<projectDir>/
package.json)` too, where the value is the file's git blob OID —
      its index OID when clean, computed when not, `''` when absent.
      Two wrong algorithm names on the page describing the module
      CLAUDE.md marks stale-hit-critical.
      Pinned as a class over every hand-authored page that states the
      formula: it must name `hashableConfig`, must not say `sha256`,
      and the two facts it is held to are read from `task-hash.ts`
      rather than restated. A floor of four copies, per 14ag, so a
      fifth is a deliberate edit and an empty result cannot pass.
      Also `blog/bitsets-and-the-scheduler.md`: the closure's memory
      read `N² / 8 bits`, where N² BITS is the size and N²/8 is the
      size in BYTES — the 1.3 MB beside it settles which was meant,
      and `Uint32Array(n * ceil(n/32))` at 3,270 is 1,347,240 bytes.
      The bits/bytes class the Rules say to measure, not assert, and
      item 388's seconds/milliseconds twin.
      The rest of the three posts holds, `from-nx.md` entirely, and
      the scheduler post's heap (max-heap on priority DESC, ties in
      graph-insertion order) and 8.5 s figure check out against
      `scheduler.ts` and optimizations row 26.

397.  DONE (2026-09-19, the copy my own item 385 never greped for).
      `blog/keys-from-git.md` numbers the twelve key parts and says so
      outright — "The parts, as Caching numbers them" — and had 11 =
      input-file hashes, 12 = plugin material, while `caching.md` has
      had 11 = plugin, 12 = inputs since item 385 corrected exactly
      that inversion. The post's own prose contradicted its own
      number in the same breath ("folded right after the upstream
      keys"), which is the tell 385 read in caching.md and then did
      not look for anywhere else. Item 381 recorded that failure —
      the same table wrong on a third page my 379 pin had not greped
      — and I repeated it four items later, on a page that names
      caching.md as its source. Its "Part 11 is where the money is"
      moved to 12 with the fix.
      And the post WAS pinned — `site-samples.unsafe.test.ts` holds its
      twelve-item count, every label it quotes, and even the sentence
      "folded right after the upstream keys". The pin held the PROSE
      and let the NUMBER beside it say the opposite: nothing tied the
      plugin item's position to the fold order. That pin also anchored
      its list regex on the literal `Part 11`, the cross-reference the
      fix had to move, so correcting the page BROKE it — a pin that
      fails when the page is fixed is anchored to the wrong thing, and
      it now matches `Part \d+ is where the money is`.
      Pinned as a class and DERIVED: `key()`'s own fold order decides
      which of the two comes first, so a reordering moves the pages
      with it rather than failing them. Discovery is a page that
      numbers the sentinel and the content hashes; two copies today,
      floored at two so a third is a deliberate edit.
      The selector was wrong once, as usual: looking for
      `cache.inputs.files` found caching.md's step 5, whose "Captures"
      list names the glob among the declarations the CONFIG hash
      folds, and called the order wrong. "Content hashes" is the
      phrase that means the input-file fold.
      The rest of the post is BETTER than the contract pages were: it
      names `git ls-files -s -v` and `git status --porcelain -uall`
      correctly and explains the three prunes against a trusted index
      id (dirty, `skip-worktree`/`assume-unchanged`, a clean filter),
      all of which `execution.md` had wrong until item 388.
      `lockfile-aware-keys.md` holds too, including the exact `vx why`
      string `plugin @vzn/vx-lockfile/pnpm`: `lockfileClaim` returns
      `{ [part]: digest }` with `part` the manager name, and
      `applyKeyHooks` names it `${plugin.name}/${part}`.

398.  DONE (2026-09-20, the signal the docs kept dropping).
      `blog/ctrl-c.md` opens on orphaned processes and claims "vx has
      one teardown, and every way a run can end goes through it" — and
      never says SIGHUP. Its exit codes were "130 after `SIGINT`, 143
      after `SIGTERM`"; `cli.md` gives the ladder as 130 / 143 / 129.
      The omission is pointed: `signals.ts` registers SIGHUP precisely
      because a task runs in its own session, so a closing terminal
      reaches vx and nothing else, and without the forward the tree
      outlives the window — which is the post's own opening anecdote.
      It also said `SIGNAL_SHUTDOWN_GRACE_MS` "is what the tests
      override". The tests set `VX_KILL_GRACE_MS` to 200 ms
      (`abort`, `cache-hygiene`, `persistent`, `signal-handling`,
      `keep-alive`); the constant is the default that env var
      overrides, so the sentence pointed a reader at a knob they
      cannot turn.
      The class was wider than the post. `execution.md` said
      "SIGINT/SIGTERM handlers" and named the pair again in its
      failure table; `modules/orchestrator.md` said "SIGINT + SIGTERM
      handlers" and again under signal forwarding. Five sites across
      three pages. `modules/signals.md` and `cli.md` had all three —
      the module page right again, as in 393, 396 and 397.
      The pin reads the registered set from `process.on('SIG…')` in
      `signals.ts` and checks the ENUMERATION SITE, not the page. That
      distinction was earned: the first draft asked whether the page
      contained the word SIGHUP anywhere, and `execution.md` passed
      with "SIGINT/SIGTERM handlers" intact because a sentence I had
      just added mentioned it — the figure-wise mistake of item 395,
      one item after writing it down. Two carve-outs, both stated: a
      page that DISCLAIMS installing handlers is not claiming the set
      (`runner.md` says "Doesn't install signal handlers"), and a
      sentence naming a suite describes that file's cases, not the set
      (`signal-handling.test.ts` covers two signals;
      `task-tree-kill.test.ts` covers SIGHUP).
      `pipeline-with-seams.md` was read too and holds: all thirteen
      hooks, in order.

399.  DONE (2026-09-20, a read with NO finding, recorded so it is
      not repeated). Three blog posts and a sample of the module
      pages' negative claims, all holding.
      `from-turborepo.md`: every `turbo.json` row agrees with
      `migrate/from-turborepo.md`, `extends` included (item 382's fix
      is in BOTH copies), and `site-samples` already runs an
      `it.each` over the two pages against the mapper's
      `KNOWN_TASK_KEYS`. One apparent error was chased and refuted:
      the post says an uninferable value becomes a `TODO(vx-migrate)`
      COMMENT, and the first grep found only `migrate-nx.ts`'s
      PLACEHOLDER, a failing command on the Nx path —
      `migration.ts:320` renders `// TODO(vx-migrate): ${todo}`, so
      the post is right.
      `watch-mode.md`: the 150 ms debounce, the ignore set, and
      exactly the seven flags `watch.ts` rejects across its three
      rejection sites — already derived by `site-samples:391` from
      the rejection messages themselves.
      `lock-and-frozen.md`: `--frozen` does no staleness check of its
      own, `vx lock --check` is the audit, `vx-lock.json` is excluded
      from every key. All three match `cli.md` and `caching.md`.
      Then the surface 14ag named next, `modules/`' "What it does NOT
      do" sections — fourteen pages, negative claims nothing checks.
      Six sampled against source and every one true: `metrics.ts`
      opens and closes nothing and writes no rows
      (`cache/run-history.ts` holds `recordRunBundle`);
      `task-log-buffer.ts` ships nothing and does export `takeEntry`;
      `filter.ts` has no `**` in NAME patterns (the `**` it has is
      the path form the page distinguishes); `kill-tree.ts` does not
      reap; `signals.ts` touches the logger only through `runEnd()`.
      Recorded rather than dropped: 14ae's box says a page that reads
      true is still read, since the series' worth is the coverage and
      not the find count. Two consecutive reads at zero yield is the
      signal that this arc has covered its surface.

400.  DONE (2026-09-20). The same drift class, read in the TESTS
      instead of the docs: a `describe`/`it` name is a claim, and
      nothing held a body to it. A probe over every `it` in
      `packages/vx/tests/*.ts` (2 874 blocks) flagged the ones with
      no `expect(` in the body; both drafts of it were wrong in the
      familiar way — the first brace-matcher treated an apostrophe in
      a comment as a string and cut bodies short, the second treated
      a backtick inside a REGEX the same way — so the sweep is a
      candidate list to read, never a verdict. 49 candidates, and all
      but one assert through a helper that throws (`assertBudget`,
      `rejects`, `expectOk`, `validate`, a `waitFor`) or through a
      value the name is about.
      The one real case: `archive-security.test.ts`'s "ignores an
      entry whose resolved path is destDir itself" called
      `restore(tar, dest)` and asserted NOTHING. It pinned "does not
      throw" while its name claims three things. It now pins all
      three — the entry is not in the returned `provided` set, the
      destination is still a directory, and nothing landed in it.
      Its comment was wrong about WHY, too, which the differential
      found: deleting the extractor's `rel.length === 0` guard left
      the test green, because `tar-stream.ts` normalizes a REGULAR
      entry's trailing slash away first, so `outputs/` arrives as
      `outputs` and `destFor` returns null. Two layers, proven
      belt-and-braces: mutate either alone and the test stays green;
      mutate both and `commit` raises EISDIR renaming a file over
      destDir. Layer 1 was unpinned, so `tar-stream.test.ts` gained
      a row for it (header name and pax override alike — the pax
      path lands BEFORE the normalization), and the pax-record
      builder moved to module scope, shared with the test that had
      it inline.
      Two claims-about-a-list fixed the way the docs arc learned to:
      `sandbox-runtime.unsafe.test.ts`'s "accepts every capability
      the schema defines" restated nine `allow` fields in a heredoc,
      so a tenth would have fallen out of its own name. It now reads
      `SANDBOX_FIELDS`/`GRANT_FIELDS`/`DENY_FIELDS` out of
      `config-schema.ts` (resolving the `as const` spreads), asserts
      its value map's keys EQUAL each set, and renders the config
      from that map. And `cache-baseline.test.ts`'s fifteen budgets
      live in their names ("median < 30µs"); nothing tied a name to
      the `budgetUs()` argument beneath it, so a retune could leave
      the name lying. The new row derives both and compares, with a
      floor of 15 and a count check so the regex cannot walk into the
      next body. It runs even under `VX_PERF=0`: it reads text, not
      clocks. All fifteen agree today.
      Differentials: adding a capability to `GRANT_FIELDS` fails the
      sandbox row; retuning one budget fails the baseline row;
      removing the trailing-slash strip fails the tar-stream row.

401.  DONE (2026-09-20, the direction 14ah names, first pass). Not
      "does the body assert" but "does it assert what the name
      says". Two finds, both in suites the docs arc leaned on.
      `task-hash-derive.test.ts` — "STABILITY: stripping remote
      leaves the REST of exec folded" varied ONE sibling
      (`timeout`). `EXEC_FIELDS` has seven, so a projection
      rewritten as a whitelist could have dropped `sandbox`,
      `persistent` or `env` with `remote` and nothing would have
      moved: two different tasks sharing a key, the stale hit that
      file exists to stop. The new row reads `EXEC_FIELDS` and
      `TASK_FIELDS` from `config-schema.ts` and the strip from
      `hashableConfig`'s own destructuring, requires a value for
      every field (so a new field fails here rather than falling out
      of the name), and asserts each one moves the key except the
      stripped one.
      The first draft of it PASSED under a real defect, which is the
      lesson of the item: `hashableConfig` fast-paths when no
      `remote` is declared (`if (cfg.exec?.remote === undefined)
return cfg`), so every variant it built skipped the projection
      — a `delete execRest.sandbox` mutation went green. It now
      varies each field twice, once beside a declared `remote` and
      once without; all three widened-strip mutations (`sandbox`,
      `persistent`, `env`) fail, and a whitelist rewrite fails on the
      "nothing is stripped" floor.
      `schema-unknown-keys.test.ts` — "the walk covers every level
      the schema has" asserted the walk EQUALS a hand-written list of
      the levels its own fixture builds. It pinned the fixture and
      called it the schema: a level added to `config-schema.ts` and
      not to `full()` leaves that list matching and the level
      unwalked, which is precisely what the file was written to
      prevent (`exec.env` shipped unchecked until 2026-09-10). The
      claim is now read from the schema — every guarded level is an
      `assertKnownFields` call and its `where` template says where it
      sits — floored at eight suffixes, with the two bare-`where`
      levels (the config root, a task) asserted separately.
      Differential: a new `${where}.cache.outputs.deep` guard the
      fixture does not build fails the row.
      The survey behind it: 185 test names quantify (every / each /
      all) across the non-doc-drift suites. Most quantify over data
      the test itself builds, which is sound; the ones worth reading
      quantify over a list the SOURCE owns. Two more were read and
      left alone — `events.test.ts`'s seven event kinds and
      `telemetry.test.ts`'s six statuses are both complete today and
      both sit behind an exhaustive `switch`, so the compiler is
      already the pin.

402.  DONE (2026-09-20). Two more claims derived, and two floored
      sweeps that found nothing, which is the finding.
      `inputs-resolution.test.ts` — "excludes every ALWAYS_IGNORE
      pattern", twice (top level and nested), over two SIX-entry
      fixture lists that restate the six patterns `inputs.ts` owns. A
      seventh pattern there leaves both rows passing with nothing
      covering it, on the list whose job is keeping a dependency tree
      out of every cache key. The new row reads `ALWAYS_IGNORE` from
      source (module-private: cache is a leaf module) and matches each
      pattern against the fixtures with `Bun.Glob`, the engine
      `resolveFiles` itself uses, requiring a hit in BOTH lists.
      Differential: a `**/.turbo/**` seventh fails it.
      Its selector was wrong first, the usual way: the array's own
      comments hold an apostrophe and a `]` (they quote
      `inputs.files: ['**/*']`), so a slice to the first `]` returned
      two comment fragments as patterns. The slice now ends at the
      bracket on its own line and drops comment lines before reading a
      quote.
      `workflow-runner.unsafe.test.ts` — the other half of "a skip is
      a silent pass". `VX_REQUIRE_SANDBOX` and `VX_REQUIRE_REAPI`
      exist because a suite that skips itself reports green, and both
      are set by hand in `ci.yml`, with nothing catching the next gate
      of that shape never being enabled or renamed on one side only.
      The new rows discover the gates by SHAPE — a bare
      `const X = process.env['VX_…']` makes the value itself the
      resource, so its absence skips; a read compared to a literal or
      given a `??` default is a knob with a working default — and
      require each to be set by some workflow. Three today
      (`VX_SMALL_DISK`, `VX_REAPI_TEST_ENDPOINT`,
      `VX_REAPI_EXEC_ENDPOINT`), all set. Differentials: renaming
      `VX_SMALL_DISK` in `ci.yml` and adding an unenabled gate to a
      test file each fail it.
      The sweeps that found nothing, both floored: 2 852 `it` blocks
      parsed, and every name claiming exactness ("exactly", "only",
      "nothing else", "no others") whose body has only `toContain` /
      `toMatch` — six candidates, all six sound (an anchored
      `toMatch(/^[0-9a-f]{16}$/)` IS exact; a `toContain` paired with
      the `not.toContain` that carries the "only"). And the remaining
      quantifier candidates from 401: `tally`'s buckets are a
      `Record<TaskStatus, …>`, so the compiler demands every status;
      `watch-rules`' seven-manager list and `sandbox-hint`'s field
      list are already derived-plus-control.
      The probe itself needed a third rewrite to get there: a JS
      cleaner that blanks comments and strings still mis-slices a
      body holding a REGEX with a backtick in it
      (`/`([^`]+)`/g`is everywhere in the doc pins), which is what
inflated the exactness sweep to twenty candidates. It now
tokenizes a regex literal by the character before the`/`.
      Three rewrites for one sweep is the cost of asking a regex to
      read a language.

403.  DONE (2026-09-20). The arc's end point: a skip prints itself, a
      test with no assertion at least runs — but a file NO task
      launches prints nothing at all, and the gate is
      `vx run ci --all`.
      Three of the commands that launch suites here look only at the
      TOP level of a `tests/` directory: the shard dealer
      `readdirSync`s it, `test.bun.unsafe` globs
      `./tests/*.unsafe.test.ts`, and `@vzn/vx-reapi#test` loops over
      `for f in tests/*.test.ts`. So a suite one directory down —
      `tests/reapi/wire.test.ts` — would be launched by nothing,
      in a repo where every package's suite IS its `test` task. No
      hole today; nothing was watching for one.
      `tests/suite-coverage.unsafe.test.ts` closes it: it IMPORTS
      each package's `vx.config.ts` (exact, not a regex over the
      file), reads every `test`-family command, and turns each into
      what it launches — the dealer's own `testFiles()` where the
      command runs the script, the globs it names otherwise, and
      everything when it is a bare `bun test` (Bun's recursive
      discovery). Every `*.test.ts` at any depth under any package
      must be taken by one. Differentials both ways: a nested file
      under `packages/vx` and one under `vx-reapi` are each reported
      by name; the control, the same file under a bare-`bun test`
      package, stays green.
      Then the helper the kill suites trust. `tests/helpers/alive.ts`
      answers "is the child dead yet" for abort, signals, keep-alive
      and task-tree, and its failure mode is silent: a helper that
      says "dead" too eagerly turns every one of those waits green
      with nothing having died. Its reason for existing — a ZOMBIE is
      dead though signal 0 still lands on it, measured at two thirds
      of the signal suite's wall time — had no test of its own.
      `tests/alive-helper.test.ts` builds the zombie the way the
      kernel does (a shell backgrounds a child that exits at once and
      then does not wait), pins the `Z` state, and asserts both
      halves in one place: `process.kill(pid, 0)` does not throw and
      `isAlive` is false. Differential: a helper that skips the
      procfs read fails it.
      Two probe lessons, both paid for. `new Response(child.stdout)
.text()` waits for the stream to CLOSE, which for a shell
      deliberately kept alive is never — the first draft timed out at
      5 s; one `read()` off the reader is what "the child printed its
      pid" means. And the row passed on the host and FAILED in the
      gate, which is how it learned where it belongs: a sandboxed
      probe (a scratch workspace, one task, `exec.sandbox`) printed
      `child pid 8` while `/proc/8/stat` said `8 (bun) S`, the task
      itself at pid 2 under a pid-1 `bwrap` — the runtime's own PID
      namespace, whose `/proc` cannot show another process's zombie.
      So the file is `.unsafe`, for the same reason the sandbox's own
      suites are.
      That move made CLAUDE.md wrong, and reading it to fix the
      membership found it was already wrong: it says the shards
      exclude the unsafe files "with `--path-ignore-patterns`", a
      flag that appears NOWHERE in the repo (the dealer's own
      `testFiles()` drops the name, so the shard command never sees
      the file). Both corrected in the same commit.
      One intermittent observed and NOT chased, recorded with its
      evidence rather than a cause: under the gate's load
      `sandbox-runtime`'s "a persistent task whose literal write
      grant meant a directory" failed once — the task's own `mkdir`
      said "File exists" as designed, but the run carried no
      "write grant `.cache` named nothing on disk" line. It passed
      on the next gate and in three standalone runs of the whole
      unsafe suite. Two candidates, neither proven:
      `sweepPlaceholders` skipping the placeholder (it requires
      size 0 AND an unchanged mtime), or the hint being suppressed
      by design because the sandbox reported something else that
      run. Whoever sees it again: the probe is a loop of that one
      row under parallel load with the sweep's three conditions
      logged.
      Lead for the next item, from that find: CLAUDE.md is the
      most-quoted page in the repo and the only one nothing pins,
      and the stated reason is stale — `caching-doc-drift` says "a
      core test may read only its own package, so that copy stays a
      rule, not a pin", but an `.unsafe` test reads the repo root by
      design (that is what `workflow-runner` and the new
      `suite-coverage` do). The invariants CLAUDE.md quotes
      (`CACHE_VERSION`, `SCHEMA_VERSION`, the hook list, the layout
      paths, the two sandbox-less tasks) are all derivable.

404.  DONE (2026-09-20). Back to the run path, which is where 14ai
      said to go: thirty items had changed docs and tests only and
      Next 6's re-measure was the oldest debt.
      The find is an observability one, and I walked into it myself
      while looking for a target: the `VX_TIMING` stage table charged
      ~12 ms of a 1,000-project warm run to `open cache`, so that is
      where a profiler looks — but the cache open is ~1 ms warm
      in-process and the stage also covered `buildPackageGraph`,
      which is the bulk of it. Measured on the bench workspace:
      `new Cache` + `assertWritable` 0.74–3.77 ms,
      `computeWorkspaceFingerprints` 0.20–1.40 ms,
      `buildPackageGraph` 2.19–8.02 ms over 1,000 projects. The stage
      now splits: `package graph` 7.5–7.7 ms, `open cache` 7.7–9.5 ms
      in a cold process. A mark is not free to ADD to the docs
      though — `module-shape-drift` pins the list to `prepare.ts` on
      one side and `timing.md` plus `benchmarks.md` on the other, so
      the pin failed until both pages carried it, which is the
      machinery working.
      Then the measurement Next 6 is owed, with the control that
      makes it mean something. Interleaved min-of-7, one workspace
      copy per arm pre-warmed by that arm, the before arm from an
      immutable `git worktree` at origin/main: 232.1 ms before,
      218.9 ms after. The A/A control — the SAME arm against both
      copies — read 246.4 against 259.0, a 12.6 ms spread between
      identical code against the A/B's 13.2 ms. So the mark costs
      nothing measurable, and the honest reading is that this shared
      4-core container resolves nothing below about 6 % even at
      min-of-7. That number is the item's real product: every future
      perf claim gated here needs an A/A control beside it, or it is
      reporting the box.
      Also read and left alone, so the next session does not redo it:
      `deriveStableKeys` is 30 ms of the 51 ms `classify + probe`
      stage (1,000 × ~25 µs of `computeTaskHash`, mostly the config
      `JSON.stringify` and the xxh3 chain — CPU, so the serial topo
      walk is not the cost), `probe` is one batched `getMany` at
      10.5 ms, and the `run graph` stage's 37.8 ms is ~38 µs per
      up-to-date task across four workers. The accumulated span table
      says `output dirs` 124 µs per task, which is the
      overlap-not-cost trap item 254 recorded: `outputDirsCurrent` is
      a handful of `lstatSync` calls.
      Correction to item 403's lead, in place: CLAUDE.md is NOT
      unpinned. `doc-references.unsafe` holds its core file paths, its
      § Live invariants constants, the suites its invariants cite and
      its Bun API list; `plugin-hooks-doc-drift.unsafe` holds the
      pipeline sentence against `PLUGIN_HOOKS`. What is unpinned
      there is small — the two sandbox-less tasks are pinned against
      the SITE's sandboxing guide, not against CLAUDE.md's copy of the
      same sentence. I wrote that lead without checking; the check
      took one grep.

405.  DONE (2026-09-20, the first warm-path WIN since the arc began,
      with the control 404 says every claim here needs).
      Where the time actually goes, measured before touching
      anything (temporary spans, since removed): of a 1,000-project
      warm run's `classify + probe`, the short-circuit is 41 of
      54 ms and everything else in that stage — the run lock 2.3 ms,
      placement 1.3, plugin install 0.4, executors 0.2, the counts
      loop 0.1 — is noise. Inside `computeTaskHash` (20.2 ms / 1,000
      calls): `resolveKeyInput` 15.0, of which `resolveInputs` 10.3,
      and `cache.key` 5.0. So the fold is a fifth of it and the
      INPUT RESOLUTION is the half worth attacking.
      REFUTED, and it was my own lead: the config `JSON.stringify` is
      not the cost. Micro-benched at 413 ns, with `xxh3hex` of the
      result 190 ns — 0.6 µs against the 20-33 µs a task spends, ~2 %.
      Moving it would change every key and cost a `CACHE_VERSION`
      bump for 2 %; not worth proposing again.
      The win: `resolveFiles` walks the project's git snapshot per
      TASK, and tasks of one project routinely declare the same
      inputs and outputs — this repo's own config is the shape, with
      twelve shard tasks each declaring the same whole-tree glob over
      the same ~3,000 files. `ProjectFilesCache` memoizes the
      resolved list by project + declaration (positives, negations,
      own outputs, project boundaries), mirroring the
      `WorkspaceFilesCache` pattern already in that file, and reuse
      is gated on the git snapshot being the SAME ARRAY the entry
      walked: a mid-run re-enumeration hands back a new one, so a
      task whose inputs an earlier task rewrote misses and walks
      again.
      The numbers, on this repo's own 44-task `run ci --all --dry`:
      `task hash` 50.6/52.9/53.3/53.3/54.9 ms before,
      37.1/37.1/37.8/37.8/40.5 after — disjoint sets, −27 %. Wall
      clock could NOT see it (A/B min 156.2 → 143.5 ms; the A/A
      control spread 167.4 vs 148.4 is larger), which is 404's
      finding holding: on this box the metric the change touches is
      the honest instrument, not the clock. Negative control, the
      1,000-project bench where every project has ONE task and no
      declaration repeats: 22.6–23.6 ms before, 21.6–22.0 after
      (plus one 28.9 first-run outlier) — no win and no regression,
      as designed.
      Differentials: reuse without the array-identity check, a key
      without `ownOutputs`, and a key without the positive globs each
      fail one of the three new rows in `inputs.test.ts`.
      One self-inflicted lesson worth the line: a `*/` inside a doc
      comment's example (`['**/*']`) closes the comment, and the
      parse error surfaced as `bun test` hanging for fifteen minutes
      rather than as a syntax error — kill the run and re-run WITHOUT
      the `| tail` that was swallowing it.
      Also here: item 403's zombie row went red under this gate, its
      second failure in four gate runs while passing every time
      alone. NOT reproduced, and recorded as such rather than
      explained — five runs of the file under four CPU burners pass
      on BOTH the old and new code, and two full runs of the unsafe
      suite (216 tests, the gate's own shape) pass. What changed is
      the fragility and the diagnosis: the pid now travels through a
      FILE instead of an unread `stdout` pipe whose lifetime the test
      does not control, and the premise is asserted — if the parent
      shell is gone, the row now says `parentAlive: false` instead of
      a state mismatch nobody can read.
      And one REAL race, found by the same gate and fixed: the site
      link row walks `packages/vx-docs/src/content/docs`, which is
      `@vzn/vx-docs#build`'s OUTPUT, while that task runs beside it
      under `vx run ci --all`. A page the import script was rewriting
      vanished between the walk and the read, and an ENOENT stack
      surfaced under an unrelated row. The walk now skips a file that
      is gone — its source is pinned by the safe half regardless —
      with the reason written beside it: a generated tree is not a
      stable input for a concurrent reader.

406.  DONE (2026-09-20). 405's own map said what to read next, and
      after the memo landed the split had MOVED: on this repo's
      44-task `run ci --all --dry`, `cache.key` is now the biggest
      at 23.5 ms of `task hash`'s 44.9, against `resolveKeyInput`'s
      21.4 (input resolution 16.3, OID map 2.9, upstream 0.7, the
      config hash 0.5, package.json 0.3). The reason is the shape of
      THIS repo rather than the bench's: `packages/vx` declares a
      whole-tree glob, so the fold walks ~3,000 files per task, 534 µs
      each, where a bench project's two files cost 5 µs.
      Split further, `cache.key`'s ~24 ms is gather 8.4 (a
      `Promise.all` over 3,000 entries the caller already holds), sort
      7.4 (a copy-and-sort of an array `resolveFiles` already sorted)
      and fold 6.4 (`relPosix` + `xxh3` per file). All three are
      key-IDENTICAL to fix:
      the order is checked instead of re-sorted (one comparison per
      file; an unsorted caller still gets a sort), the digests are
      gathered in a plain loop when the OID map covers them (the
      first gap falls back to the awaited form for the whole list),
      and `relPosix` is memoized per Cache while the workspace root
      holds — 132,000 calls for 3,000 answers on this gate.
      Proof the key did not move: every task hash of a `--dry` plan
      compared between origin/main and this tree — 34 on this repo,
      then 1,000 on the bench workspace, all identical. Two lessons
      in that check. The first version extracted ZERO rows and
      printed "IDENTICAL" over an empty diff, so the floor
      (`-ge 30`, then `-ge 900`) is what made it a real pass — the
      third time this arc that the selector, not the claim, was the
      bug. And this repo is the WRONG tree for a second look: its
      own sources are its tasks' inputs, so editing a test moves the
      keys legitimately; the bench workspace, whose files nothing
      touches, is where the comparison means something.
      Measured, disjoint sets, five reps each: `task hash`
      49.1–61.3 ms on origin/main, 41.5–42.9 with 405 alone,
      26.3–34.7 with both — about −45 % against main. Control on the
      1,000-project bench, where each task has two input files and
      nothing repeats: 21.8–24.9 before, 20.8–28.0 after, overlapping
      — no win, no regression, which is what a per-file cost should
      look like when there are two files.
      Two pins, each with a differential: a list whose only inversion
      is at the END (an off-by-one in the order scan lets it through,
      and the existing order row breaks at the first pair instead),
      and a Cache asked for a second workspace root (an uncleared
      memo folds one tree's names under another's). The second was
      vacuous when first written — the file sat outside BOTH roots,
      so `../shared.txt` was the answer either way and the broken
      memo passed; it now lives inside root-a.
      And the intermittent item 403 recorded came back on this gate,
      which made it a second sighting and therefore work. It is a
      REAL defect, not test noise: a persistent task that fails
      readiness sweeps its placeholders TWICE — once from the child's
      exit handler, once from the readiness catch — and
      `sweepPlaceholders` returns only what IT removed, so whenever
      the exit handler won the race the "write grant `.cache` named
      nothing on disk" hint was never printed and the failure said
      only "File exists", which is the message the hint exists to
      explain. The catch now reports the UNION of both sweeps.
      It does not reproduce in isolation (8/8 under four CPU burners,
      5/5 alone), so the differential forces the race instead: a
      150 ms sleep before the catch's sweep makes the exit handler
      win every time — the old code fails that, the new code passes.
      The ingredient is pinned where it is deterministic, in
      `sandbox-request.test.ts`: a second sweep names nothing,
      because the first one took it.

407.  DONE (2026-09-20). The profile after two wins, and the leads
      closed rather than left open — with three hypotheses refuted,
      all three mine.
      The 1,000-project warm run is 212 ms and now FLAT: startup 7.9,
      workspace config 21.2, discover 18.5, package graph 8.7, open
      cache 8.5, load configs 25.1, git enumeration 10.3, build graph
      5.2, classify + probe 56.1, run graph 36.0, record history
      10.5, close 4.0. Nothing left is a hot spot — the biggest
      single piece inside any stage is under 4 ms — so the next win
      is STRUCTURAL, not a micro-optimization. The structure worth
      naming: about half the run (105 ms) is preamble before a task
      is considered. CORRECTED by item 408 — the overlap this entry
      proposed there is worth ~1.4 ms, not ~8: `new Cache`,
      `assertWritable` and `noteSchemaReset` are SYNCHRONOUS, and a
      single-threaded runtime cannot overlap them with anything. Only
      `computeWorkspaceFingerprints` (0.2–1.4 ms) can move. Do not
      take that lead.
      REFUTED, in order. (a) `probe` at 12–13 ms looked like 1,000
      `existsSync` calls inside the batched `getMany`; isolated, a
      thousand of them cost 1.7–2.6 ms, and the split is entries SQL
      3.5 / exists 2.8 / file rows 2.2 / dir rows 2.0 / build 1.9 —
      proportional work, already chunked at 900 per query, no target.
      (b) `load configs` at 25 µs a project is not an un-batched read:
      `getConfigEvals` already takes the whole key set in one query,
      and what remains is the per-config fast-key hash and a
      `JSON.parse` each. (c) `output stat` at 29 µs a task and
      `output dirs` at 109 µs are not costs at all — they are the
      accumulated table's overlap, the same trap item 254 recorded,
      and `isOutputsCurrent` is one `statSync` per output file by a
      2026-09-09 measurement that is still right.
      Which is the change this item ships: the table now says so
      itself. `printTimings` prints one line under the accumulated
      rows — "wall per call, summed; concurrent calls overlap —
      compare spans, not totals" — because the caveat lived in
      benchmarks.md and in a STATUS item, and both of us who read the
      table anyway (item 254, and me twice today) chased the number
      before isolating it. `modules/timing.md` says the same in the
      page a reader has open.
      Also read and left: `listProjects` reads each `package.json`
      once and `hashProjectPackageJson` takes the git OID, so there
      is no duplicate read to remove on a clean tree.

408.  DONE (2026-09-20). The perf arc closed with a correction, and
      then the first-run path walked end to end — the DX read Next 7
      did on 2026-09-04, on a workspace a beginner would actually
      have: three packages, `package.json` scripts, a dependency
      edge, a persistent `dev`.
      The correction first, because it stops a wrong lead: 407 named
      an overlap of the cache open against discovery and put it at
      ~4 % of the run. It is worth ~1.4 ms. `new Cache`,
      `assertWritable` and `noteSchemaReset` are synchronous, and
      nothing overlaps synchronous work in a single-threaded runtime;
      only `computeWorkspaceFingerprints` is awaited. Fixed in 407's
      entry in place.
      The walk, fifteen probes. What already teaches, recorded so it
      is not re-walked: a bare `vx run build --all` in an
      unconfigured workspace names `vx init`; `init` writes a config
      per package, reports "3 tasks migrated clean, 4 TODOs" and puts
      the exact `cache` block to paste in the TODO; a typo'd task and
      a typo'd filter each get "Did you mean"; a `dependsOn` naming
      nothing says which task and which package; an `outputs` glob
      that matches nothing says an empty artifact is saved and a hit
      restores nothing; a `..` in `inputs` or `outputs` is refused
      with the FILE, the field, the value, the reason and the
      alternative (`workspaceFiles`); exit 127 gets a hint naming the
      two `.bin` directories vx puts on PATH; `vx why` names the
      upstream whose key moved, with both digests; `vx show` prints
      each task's command, deps, inputs and outputs; `lock` +
      `--frozen` round-trips; a gitignored `dist/` caches, restores
      ("3 local"), and reads up-to-date on the next run.
      The one gap, fixed: `vx cache stats` — what the other runners
      call it — answered "unknown subcommand" and sent the reader to
      a help screen listing only `prune`, which teaches what vx does
      NOT have. `stats`, `status`, `size`, `entries`, `dir`, `path`,
      `clean`, `clear`, `rm`, `delete` and `evict` now name the verb
      that answers them (`vx info` for the statistics, `vx cache
prune` for eviction), a typo of `prune` still gets the
      nearest-neighbour hint every other surface gives, and the help
      screen and `cli.md` say where the statistics live.

409.  DONE (2026-09-20). The other adoption path walked the way 408
      walked the first-run one: `vx-migrate` on a Turbo workspace,
      then the same repo run UNCHANGED through the `turbo()` plugin.
      What holds, so it is not re-walked. The CLI on a plain
      `turbo.json` writes a config per package plus `vx-preset.ts`,
      reports "5 tasks migrated clean, 1 TODO" and the TODO is the
      persistent task's `readyWhen`. On a turbo.json using the hard
      fields it maps `globalEnv` to BOTH `cache.inputs.env` and
      `exec.env.passThrough` while `globalPassThroughEnv` goes only to
      the latter; `$TURBO_DEFAULT$` to `**/*`; a negated INPUT
      through as-is; a negated OUTPUT to a TODO (vx has no output
      negation); `//#format` to a note that vx has no workspace-root
      tasks; `interactive` to a TODO; and a cross-project
      `dependsOn: ["ui#codegen"]` straight through — and the result
      RUNS, `deploy` uncached, `codegen` before `build`.
      Package-level `turbo.json` with `extends: ["//"]` merges over
      the root task field by field: `.next/**` and the package's
      `env` win, the root's `inputs` and `passThroughEnv` stay.
      The plugin path: a workspace whose only vx file is a
      `vx.workspace.ts` naming `turbo()` runs the Turbo repo with no
      config written, warns once about the persistent task, caches,
      and re-runs every task when `turbo.json`'s
      `globalDependencies` file changes — the mapping that matters
      most, since a missed global is a stale hit.
      One doc fix, from a near-miss worth recording. The `extends`
      row read "any other key replaces the root's definition rather
      than inheriting it", which I first took as contradicting the
      mapper's `{ ...root, ...overlay }` merge that the walk had just
      shown. The tests settle it — `turbo.test.ts:329` pins
      `extends: false` alone as the opt-out and with keys as "runs on
      those keys alone", `migrate.test.ts:191` pins the merge — so
      the row was about the `extends: false` FORM and over-generalized
      in a way that reads as the opposite of the behaviour. Both
      copies (the migrate guide and the blog table) now say the
      package task merges field by field, and what `extends: false`
      does, separately.
      Also confirmed on the way: a missing plugin package is refused
      with "cannot find '@vzn/vx-migrate' — no node_modules above the
      config provides it; install the workspace's dependencies
      first", which is the right sentence for the most likely
      first-time failure.

410.  DONE (2026-09-20, a real defect in the Nx migration, found by
      walking it). The trim is NOT due: the loop holds 373–410, and
      item 373's line is forty — checked rather than assumed, since
      the check-in that scheduled this item guessed it was close.
      The Nx path needs no `nx` install: the migrator reads
      `.nx/workspace-data/project-graph.json`, so a hand-written
      graph walks it. One covering `nx:run-commands` (both `command`
      and `commands`), `nx:run-script`, a bare `command`, `nx:noop`,
      a foreign executor, `namedInputs` (including `production` and
      `sharedGlobals`), `{projectRoot}` and `{workspaceRoot}` output
      tokens, `continuous: true` and a cross-project dependency.
      The defect: Nx separates a specific project's target with a
      COLON (`ui:build`); vx's separator is `#`. The OBJECT form
      (`{ target: 'tool', projects: ['pkg-b'] }`) was mapped
      correctly, the STRING form was pushed through verbatim, and the
      migrated workspace then refused to run — "Task web#build
      depends on web#ui:build but no such task is declared", out of a
      config `vx-migrate` had just written and called migrated. It
      now maps `project:target` to `project#target`, says so for a
      `project:target:configuration` (vx has no configurations, so
      the suffix is dropped and the kept edge named), and drops an
      edge to a project the graph does not contain with a TODO that
      names it. Three pins, each failing without the fix; the guide's
      dependsOn row says the mapping.
      What else the walk confirmed, so it is not re-walked: named
      inputs expand (`production` → `['**/*', '!**/*.spec.ts']`,
      `sharedGlobals` → `workspaceFiles`), a `{workspaceRoot}` output
      becomes `outputs.workspaceFiles`, a missing `package.json`
      script for `nx:run-script` becomes a TODO and a command that
      fails loudly rather than a silent no-op, `nx:noop` with
      `dependsOn` becomes a group task and without one is skipped
      with a line, and `cache: true` with no declared inputs defaults
      to `['**/*']` with a TODO to narrow it.

411.  DONE (2026-09-20, the rest of the Nx input surface, same walk).
      Item 410 read the dependency forms; this one reads the INPUT
      forms, built into the same hand-written graph and checked by
      RUNNING the migrated config, not by reading what it printed.
      One more defect: `{ runtime: "<cmd>" }` fell through to the
      report line `input {…} not representable in vx` while
      `docs/schema.md` documents `cache.inputs.runtime` as
      "the runtime-output analog of `inputs.env`. The Nx `runtime`
      input equivalent" — the one field written FOR this mapping was
      the one the mapper did not reach. It now emits
      `runtime: ['node --version']`, and the migrated workspace runs
      and caches on it (second run reads up-to-date).
      The other shapes were already covered and are recorded so they
      are not re-walked: `{ env }` maps to `cache.inputs.env` AND
      `exec.env.passThrough` (a vx task's env is isolated, so hashing
      a variable is not enough to pass it), `{ fileset }` expands,
      `{ externalDependencies }` and `{ dependentTasksOutputFiles }`
      each become a TODO that says why vx needs neither, and a
      `{token}` vx has no answer for becomes a TODO rather than a
      silent drop. The guide's table now has a row for `{ env }` and
      `{ runtime }` beside the `files` ones.
      Also fixed: the implicit-dep note counted without naming, so
      "1 implicit Nx dep not representable" sent a reader through the
      whole graph for the pair they have to write the `dependsOn`
      from. It now names them — `(pkg-a → pkg-b)`, capped at five
      with "and N more".
      Not a defect, checked: `targetDefaults` are not applied by the
      migrator because the project-graph snapshot is ALREADY
      resolved — my first fixture put defaults in `nx.json` and
      expected them merged, which no real `nx graph` output would
      have. The unrealistic fixture was the bug, not the mapper.

412.  DONE (2026-09-20, the trim item 373's convention puts at forty).
      With this entry the loop stood at forty, 373–412, so items
      373–392 moved whole to
      `docs/history/2026-09-improvement-loop-373-392.md` and the loop
      keeps 393–412. A PREFIX, as item 373 set it: the formatter
      renumbers an ordered list sequentially, so a cut from the middle
      renumbers every entry below it and silently breaks the
      cross-references in this file and in the test comments that cite
      item numbers. Nine earlier history heads and the record
      paragraph repointed; handoff 14aj moved to the next-log and 14ak
      takes its place.
      The edit script asserted everything before it wrote anything and
      refused once before it ran — the pointer clause it had to rewrite
      exists in TWO forms ("items 373 onward continue in STATUS under
      the same numbering." in the six oldest heads, "…in
      `docs/STATUS.md`." in the three newest), and a regex for one
      matched none of the other six. It also refused AFTER writing, on
      its own last check rather than on the tree: "14aj is gone from
      STATUS" is false by construction once the record paragraph says
      where 14aj went, and the entry it was checking for had moved
      correctly. An assertion that forbids a whole STRING forbids the
      sentence that records the move; the check is for the entry at
      line start (`^14aj\.`), and it is fixed in the script. Counted
      before and after: twenty out, twenty left, twenty in the new
      file.

413.  DONE (2026-09-20, the last adoption surface: the two remote-cache
      plugins, walked as an ADOPTER rather than as a wire). The spec
      suites already pin both protocols, so this read the guide's
      promise instead — "any failure — a 500, a timeout, an auth error,
      a corrupt artifact — degrades to a local cache miss and the run
      continues" — by pointing `turboCache()` and `nxCache()` at a
      server hostile in each of those four ways and RUNNING a
      workspace against it. All four hold for both wires, and each is
      now a row in `tests/remote-cache-degrade.test.ts` (with a
      healthy-server CONTROL that proves the artifact really does
      round-trip through it, so a green suite cannot mean the remote
      was never consulted).
      The defect the walk found is in the claim next to the code: both
      plugins said a refused token "throws ONCE … so a bad token costs
      one line, not one per task", and `README.md` repeated it. A run's
      requests are CONCURRENT — the probe pass asks for every task at
      once — so several refusals are in flight before the first sets
      the layer off, and six projects under a bad token printed FIVE
      identical warnings. `request()` now returns `undefined` for a
      refusal that is already reported and each caller degrades to its
      own miss value in silence; one line, proven at the class (exactly
      one rejection out of five concurrent calls, each other call
      returning its miss value) and through the CLI (six projects, one
      warning, exit 0). Both pins fail without the fix, 5 against 1.
      Two method notes. `Bun.spawnSync` in the parent BLOCKS the event
      loop that serves the stub the child is dialing: the first version
      of the run-level probe read "The operation timed out" and I spent
      a detour on proxy variables before testing the premise — the
      server had recorded no hit at all. And a timeout does NOT disable
      the layer (only 401/403 does), so a wedged server still costs one
      deadline per request; that is the design (a cache that answers
      slowly once may answer fast next time), and the deadline is
      configurable, but it is worth knowing before someone reports it
      as a hang. A third, smaller: a stub whose hostile mode sleeps must
      let go when the client aborts, or the `afterAll` that awaits
      `server.stop()` waits for the sleep and the hook times out at five
      seconds — the sleep now races the request's abort signal.

## In flight

**The gate's baseline in a cloud container (2026-09-19).** A session
that gates somewhere other than a dev box will see `vx run ci --all`
come back red with roughly two dozen failing tests and ten failing
tasks, and diffing against that set is only honest once the set has a
cause. On the 2026-09-19 container the cause is mostly ONE thing: the
box ships **Bun 1.3.11** while both `package.json` files declare
`"bun": ">=1.4"`, and one suite cross-checks vx's tar against
`Bun.Archive` (item 389 corrected the claim that core DEPENDS on it —
it does not; the oracle is where the failure lands).
Ten of the 23 are that, verified — `@vzn/vx-reapi` refuses to load
with its own version error (3), `tar-stream` fails inside
`Bun.Archive` (1), `project-loader` gets a `BuildMessage` where 1.4
gives the error its classifier turns into a `UserError` (3), the
runner reads no `peakRssBytes` at all (2), and `bin.ts` truncates a
2 MiB pipe write to 219 KB, the very defect the Rules section records
as fixed (1). Four more are downstream of that missing usage number
(`vx last`, the remote-usage e2e, both schedule-history reservation
cases). Seven are the watch loop and `armWatcher`, and item
369 MEASURED what this sentence first guessed: they are the floor too.
Bun 1.3.11's `fs.watch` never reports a DOT-prefixed filename — a
plain file is delivered, `.vx-watch-probe` is dropped, in both
recursive modes — and that probe is exactly how `armWatcher` proves a
watcher is live. So 21 of the 23 are the runtime, not 10. That leaves TWO — the
`--continue=always` pair — which pass 3/3 in isolation and fail only
beside eleven other shards, as `output-memory`'s RSS case does. Those
two are the whole of what load explains. The controlled comparison closes it: CI pins
`bun-version: 1.4.2` in `ci.yml` and every PR of this arc went green
there — same tree, same tests, 23 red here and none there. Upgrading
is not available in the container: `bun upgrade` is refused by this
build and bun.sh answers 403 through the proxy. So the yardstick stands, with its meaning stated: a gate here
is honest against the failing-TASK set and the failing-TEST set
together, and anything outside both is the diff's.
One more shape to expect, first seen 2026-09-19 under item 380: a
shard can die with **exit 132 (128 + SIGILL)** and report no failing
test at all — the Bun process crashed, so the failing-task count goes
to eleven with nothing new in the failing-test set. Shard 9 did it
once and then passed 271/271 twice in isolation and again on the next
gate. Treat a bare SIGILL like that as this runtime under twelve-way
load, not as a find: re-run the shard alone, and the gate once, before
reading anything into it.
Item 388 saw it twice in a row — under the gate and again alone, both
times after the config-evaluation worker suite's last passing test —
and then on a clean `origin/main` tree, which is the control that
settles whose it is. Item 388's entry called it deterministic on that
evidence; item 389's gate had shard 9 green, so it is NOT. Two
recurrences are not a pattern: the count moves between ten and eleven
failing tasks, and the eleventh names no test. What actually settles a
SIGILL is the clean-tree run, not how many times in a row you saw it —
a shard that dies without your diff is the runtime's however often it
does it.

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
   config is what makes 5,000 cheaper per project than 1,000. PARKED for
   the 2026-09-19 arc (items 341–362): it changed docs, comments and
   tests only, so there is no run-path delta to A/B, and the arc ran on
   a shared 4-core container whose own baseline fails 23 tests for
   environmental reasons — an absolute figure from it is not comparable
   to the table above, and an A/B has no arms. Re-measure on the first
   run-path change. UNPARKED 2026-09-20 (item 404), with the container's
   own noise floor measured first: interleaved min-of-7, one workspace
   copy per arm pre-warmed by that arm, 1,000 projects warm all-hit —
   the A/B read 232.1 ms before against 218.9 ms after, and the A/A
   CONTROL (the same arm against both copies) read 246.4 against
   259.0. A 12.6 ms spread between identical code is the same size as
   the 13.2 ms "difference", so this box resolves nothing below about
   6 % even at min-of-7. Absolute figures here, for the record and not
   for the table: 1,000 projects warm 194–204 ms total
   (`bun packages/vx-bench/run.ts 300 3`: no-cache 987 ms, warm
   172 ms, warm-restore 329 ms). Any future claim on this container
   needs an A/A control beside it.

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
    270, 275, 281, 287, 293, 299, 305, 312, 319, 326, 332, 383 and
    394, 400, 403 and 409 (14–14aj) are in
    `docs/history/2026-09-status-next-log.md`; 14ak below is the
    current one.

14ak. **Handoff after item 412 (2026-09-20).** Three items since 14aj,
two of them the Nx migrate surface and the third this file. 410 and 411
walked `@vzn/vx-migrate`'s Nx path end to end, which needs no `nx`
install at all — the migrator reads the RESOLVED
`.nx/workspace-data/project-graph.json`, so a hand-written graph is a
faithful fixture — and each found a real defect in code that had never
been run against the shape it claimed to map: a `dependsOn` string of
the form `ui:build` was written through verbatim, so the migrated
workspace refused to run out of the config `vx-migrate` had just called
migrated; and `{ runtime: "<cmd>" }` was reported "not representable in
vx" while `docs/schema.md` names `cache.inputs.runtime` as that input's
equivalent. Both now have pins that fail without the fix. 412 is the
trim: the loop had reached forty with this entry, so 373–392 moved
whole to `docs/history/2026-09-improvement-loop-373-392.md`.
What the two walks taught, beyond the fixes. A mapper is only as good
as the shapes someone has RUN through it: printing a report that says
"migrated" is not the same claim as the workspace running, and both
defects survived because the reading stopped at the report. And check
the fixture before the code — my first `targetDefaults` fixture put
defaults in `nx.json` and expected them merged, which no real `nx graph`
output would ever hold, so the "gap" it showed was mine.
Open: Next 1, 2 and 16, gated by their own terms; Next 6 carries item
404's noise floor, so the next run-path change has a yardstick and an
A/A control to sit inside. The owner residue — the `NPM_TOKEN` secret,
the release cut, the site's address. No open issues. The container's
baseline is 21–23 failing tests and ten failing tasks, eleven when
shard 9 takes its SIGILL, and the clean-tree control is what settles
which set you have.
Next: the loop holds 393–412, twenty entries, so the trim is paid and
the next one is due at 432. For work: the adoption walks are done (first
run 408, Turbo 409, Nx 410–411); what stays untried is `turboCache()` /
`nxCache()`, which need a server to talk to, and the Nx path against a
graph dumped from one of the five real Nx repos rather than a
hand-written one — REPOS.md says which, and the graph file is all it
needs. Never end with "what next?".

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
