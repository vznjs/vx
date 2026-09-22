# The mutation sweep: method and rules (2026-09-18 → 09-21)

**Status: the record of a finished campaign.** Items 342–572 swept core
one source file or region at a time; item 572's verdict is that the
candidate list is exhausted (a file whose failure mode is LOUD — a wrong
edge that fails a build — does not clear the bar). These rules lived in
CLAUDE.md while the sweep ran (plan I1 moved them here, item 578); they
are what a future sweep starts from, and they stay out of the every-session
memory because they are only useful while sweeping.

## The method

1. **A worktree, never the checkout.** A sweep holds a file in a mutated
   state for a minute at a time; a checkout that is also being edited
   gets the mutation committed.
2. **The pinned Bun.** `bun --version` against `engines.bun` and CI's
   `bun-version` before the first mutation; when they differ, fetch the
   release asset and run under it. The gate refuses below the floor
   since item 575.
3. **One `bun test` per file, with `--timeout` sized by the failure
   mode**, and a per-file summary line (`N pass`, `N skip`) that the
   driver READS: no summary is INCONCLUSIVE, a skip is INCONCLUSIVE, a
   crash is INCONCLUSIVE. Only a `(fail)` row is CAUGHT; only a full
   green summary is SURVIVED.
4. **The file list is the fixture.** Grep the region's OUTPUT — the
   sentences it prints, not only the identifiers — and run every file
   that asserts one.
5. **Type-check per mutation for a declaration-heavy file.** `bun test`
   is transpile-only and cannot see a type error, so a mutation of a
   type, a constant's shape or an export list "survives" a suite that
   never compiled it.
6. **Every survivor gets a second question before a row**: what ELSE
   would have to fail for the observable to change? Mutate that too.
   Two guards masking each other (563, 565) is the commonest false
   survivor.
7. **A row for a real survivor carries a control** that passes with the
   guard present, past any coarse gate that would hold it anyway.

## The rules, as CLAUDE.md recorded them

- A CRASHED run is a silent pass too, and a mutation sweep is where it
  bites: a `bun test` that panics (SIGILL, exit 132) prints no `(fail)`
  line, so a driver counting failures reads the crash as "the mutation
  survived". Six of six survivors in one sweep were crashes, and the
  write-up would have claimed a well-held guard was unheld at five
  levels. Require a per-file summary line (`N pass`) and treat its
  absence as INCONCLUSIVE, never as a pass; one `bun test` per file
  also keeps one panic from voiding the whole run (2026-09-21).
- And a SKIPPED row is a silent pass in a sweep, even where the repo
  already guards it. Six rows across five suites are `skipIf(root)`
  (`tests/helpers/nonroot-gate.ts`); CI runs non-root with
  `VX_REQUIRE_NONROOT=1` so they bind there, but a sweep in a root
  container sees `4 skip` in a summary it never reads, and the
  mutation those rows exist to catch reads as SURVIVED — item 481
  found the same hole from the other side. A verdict script must sum
  ` N skip` and say so; a region whose rows skip here is
  INCONCLUSIVE on this machine, never a survivor, and the write-up
  names the row and the gate rather than claiming a hole
  (2026-09-21).
- THE SWEEP'S FILE LIST IS THE FIXTURE THAT DECIDES EVERY VERDICT. Item
  553 ran the five files that name the region's functions and reported
  eleven survivors across the label vocabulary; re-running the same
  mutations over the files that assert the STRINGS those functions
  produce (framed-output, run-report, signal-death,
  persistent-ready-timeout) caught ten of them. Grep the region's OUTPUT
  — the sentences, not only the identifiers — and run every file that
  asserts one, before calling anything unheld.
- A mutation that does not COMPILE reads as a survivor, not as a
  catch: Bun prints `# Unhandled error between tests`, `0 pass` and NO
  `(fail)` row, so a driver counting failures scores it SURVIVED and
  the write-up claims a hole in code the run never loaded (item 550,
  a `try` left dangling when its `catch` block was deleted). The
  classifier now reports a module error, or a file that printed
  `0 pass` with no failing row, as INCONCLUSIVE. A bare `^error:`
  grep does NOT distinguish it — a failing assertion prints
  `error: expect(received)…` too, and that check called every genuine
  catch a compile failure.
- A test fixture that stands in for a seam's CALLER enters by another
  door than the product does, so the host between them has no witness:
  nine rows handed `affectedProjects` a claim whose `affected` returned
  a Set directly, and `claimedAffected`'s whole shape guard could be
  deleted with the suite green (item 544). Check which door the fixture
  uses before crediting coverage.
- An arm of an `||` guard can be refused by a sibling arm: removing the
  explicit `typeof x === 'string'` changed nothing, because a string is
  not an `'object'` either (544). Measure WHICH arm fires before calling
  one unheld — and keep the row, which still fails when the guard goes.
- A COST gate needs a fixture that can see the cost. `task.log`'s
  opt-in row asserted only that no record arrived — which `deliver()`'s
  own kind filter guarantees whether or not the gate above it exists, so
  the gate AND the `wants` scan behind it could both go with the suite
  green (item 556). When a later filter answers the same question, pin
  the work that was skipped: the row now hands the subscriber an event
  whose `chunk` is a GETTER and counts the reads.
- A fixture can DISARM the claim it is named for, one step earlier in
  its own body. "emitSummary + flush are crash-isolated" throws from
  `onRunSummary` first, which DISABLES the sink — so `flush` returned
  before ever calling it and the whole flush error path (its warn and
  its swallow) had no witness in any fixture (556). Read a fixture's
  steps in order and ask which of them the subject still sees.
- `bun test` IS THE WRONG INSTRUMENT FOR A DECLARATION-HEAVY FILE, and
  it fails silently: it is transpile-only, so a sweep over a file that
  is mostly interfaces reports every schema claim as a survivor (item
  558, `config.ts`). The gate already owns the other instrument —
  `lint.oxlint` is `oxlint --type-aware --type-check`, it covers
  `tests/` as well as `src/`, and a compile-time row is written as
  `@ts-expect-error` (an unused one is TS2578, which is what makes it
  fail when the refusal goes). Run both per mutation; a mutation the
  gate refuses at either is caught.
- And the TYPE-CHECK's file list is a fixture exactly as the sweep's
  is: naming `src/` alone scored `defineProject`'s whole `dependsOn`
  compile validation a hole, when `tests/config.test.ts` had pinned it
  with an `@ts-expect-error` all along (558). Run the gate's own
  discovery, not a list you chose.
- A compile-time TRIPWIRE cannot catch its own removal. `_pluginHooksMatch`
  refuses a `PLUGIN_HOOKS` that drifts from `Plugin`'s keys, but with no
  drift on the tree a half pin and a whole one behave identically, so
  deleting it is vacuous, not a survivor (558). Measure that it FIRES —
  introduce the drift each arm exists to catch — instead of trying to
  test its existence.
- THE STORAGE LAYER MAY BE ANSWERING FOR THE SORT YOU ARE TESTING.
  Deleting `entries.sort(...)` in `cacheKeyDiff` changed nothing,
  because `entry_inputs` is PRIMARY KEY (entry_hash, kind, name) and
  the scan already returns that order — but in SQLite's BINARY
  collation, while the sort is `localeCompare`. Measured: the scan
  gives [Banana, Zed, apple], localeCompare gives [apple, Banana,
  Zed] (item 559). An all-lowercase fixture makes the two agree and
  hides the sort entirely; mixed case separates them. Same shape as
  555 — find what answers first.
- `bun:sqlite` returns a large INTEGER column as a JS number, not a
  bigint, unless the handle sets `safeIntegers` — so a `bigint`
  annotation on a read is false and the value rounds above 2^53 (item
  559; a bound bigint parameter loses it on the WRITE side too, so
  probe with a SQL literal). Check which the driver actually hands
  back before believing a type that was never enforced.
- RUN A MUTATION SWEEP IN A WORKTREE, NOT THE CHECKOUT. A sweep holds
  deliberately BROKEN source for its whole duration, so doing it in the
  working copy makes "uncommitted changes" indistinguishable from real
  unsaved work — and committing to clear that is pushing a corrupted
  file. `git worktree add --detach $SP/wt <sha>`, symlink the installed
  `node_modules` (root and each `packages/*/`) so `bun test` runs there
  unchanged, and point the driver at it; rows are authored in the main
  checkout and copied in before each run (item 560).
- SIZE A SWEEP'S TIMEOUT BY THE FAILURE MODE, NOT THE PRISTINE RUNTIME.
  The scheduler's dominant failure mode is a HANG (`runGraph` never
  resolves), and bun's DEFAULT per-test timeout is 5s — so ONE hung
  mutation costs 49 rows x 5s = 245s in one file, blowing a per-file
  `timeout` picked from the pristine 1.3s. The file is then truncated
  before its summary line and the classifier reads a GENUINE CATCH as
  INCONCLUSIVE (item 560, `tl-restore-drained-first`: 46 of 49 rows
  actually red). Cap bun's own per-test timeout (`bun test --timeout
1500`) after checking every file still passes clean at that cap on
  pristine.
- A MUTATION CAN BE A NO-OP, AND THEN IT PROVES NOTHING. `dr-then-catch`
  inserted a pass-through `.catch((e) => Promise.reject(e))` ahead of
  `.then(f, g)` — which leaves both arms intact, so the "survivor" was
  measuring nothing at all (560). When a mutation of a well-commented
  invariant survives, first check the mutation actually changes
  behaviour; write the shape the comment FORBIDS (here `.then(f)
.catch(g)`), not something adjacent to it.
- A READ-THROUGH AND A MUTATION SWEEP ARE NOT SUBSTITUTES, and item
  561 is the clearest case: 423 read `execute-task.ts` end to end
  against the live invariants and found two gaps, then the sweep found
  ten more in the same region — including the one sitting directly
  BESIDE what 423 pinned. It pinned the WRITE half of the
  policy asymmetry (the clean) and even noted the neighbouring row
  proved nothing about it; the READ half was never examined, and its
  own `--force` fixture builds a COLD project, so whether a probe
  happens is invisible to it. When STATUS records a file as read and
  found clean, that is not evidence it is held.
- NEVER TOUCH THE SWEEP'S FILES WHILE IT RUNS. The driver rewrites the
  same source path every iteration, so an out-of-band apply or restore
  silently reassigns a verdict to the wrong mutation — and a stray
  `--restore` manufactures a SURVIVED out of a mutation that was never
  tested, which is precisely the silent pass the method exists to
  prevent (item 563; the two affected verdicts re-ran identically, so
  nothing was misreported, but only a re-run could establish that).
  Queue edits to the mutation table for after the run, and re-verify
  any verdict taken while the tree was touched.
- TWO GUARDS CAN MASK EACH OTHER, so each alone survives and only the
  PAIR is held. `writeArtifactAndIndex` writes to a temp and unlinks it
  on failure: mutate either and the rejection rows still see no file at
  the final path, because the unlink cleans up what the bad write left.
  Remove both and seven rows go red (item 563, the 536/544 shape). When
  a guard survives, ask what ELSE would have to fail for the observable
  to change, and mutate that too before calling it unheld.
- A NEGATIVE `existsSync` PROVES NOTHING WITHOUT THE POSITIVE FIRST.
  The TTL prune row asserted `<cacheDir>/h-old` was gone — a directory
  from a layout three schema versions old, so it was gone BEFORE the
  prune too, and deleting prune's whole artifact unlink left the suite
  green (item 564). Assert the thing is THERE first, in the same row;
  a path that changed name is otherwise indistinguishable from a
  deletion that works.
- AND A CONTROL HELD BY A COARSE GATE HOLDS NOTHING ABOUT THE FINE
  ONES. Every control in the orphan-sweep row was FRESH, so the grace
  window alone kept them and all three narrowing guards — the
  extension test, `isFile()`, the temp-suffix offset — could go with
  the suite green; one of them reaps `cache.db` itself (564). Put each
  control PAST the coarse gate, so the only thing left holding it is
  the guard it is named for.
- AND WHEN SEVERAL ODDITIES SHARE A CONTAINER, SUSPECT THE CONTAINER.
  Three recorded "flappers", `shard-9`'s 1-in-8 SIGILL, and three
  containment guards that scored as survivors were ONE fact: Bun
  1.3.11, below this repo's `engines.bun: >=1.4`, where CI pins 1.4.2
  (items 566, 572). Each had its own plausible local story — load, a
  runtime bug, a thin fixture — and each story was wrong. Measured by
  interleaved A/B on the shard's own files: 1.3.11 failed 3 of 24,
  1.4.2 failed 0 of 24. Before attributing a flake to load or to the
  runtime in general, check the runtime's VERSION against what the
  project declares and what CI runs.
- CHECK THE RUNTIME AGAINST THE DECLARED FLOOR BEFORE TRUSTING A
  SWEEP. This container ships Bun 1.3.11; the repo declares `>=1.4`
  and CI pins 1.4.2. `Bun.Glob.scanSync` does not descend symlinked
  directories on 1.3.11 and DOES on 1.4.0 — so every symlink-escape
  tripwire in `inputs-resolution.test.ts` is INERT here. It prints no
  `skip`: the rows pass, they simply cannot fail. Item 566 scored five
  containment guards as survivors on 1.3.11; re-run on 1.4.2, three
  were CAUGHT. Worse than a wrong verdict, the local gate is quietly
  weaker than CI on exactly the guard that decides what gets DELETED.
  `bun --version` against `engines.bun` and the workflow's
  `bun-version` is the first thing a sweep does; when they differ,
  fetch the pinned build
  (`github.com/oven-sh/bun/releases/download/bun-v<x>/bun-linux-x64.zip`)
  and run the sweep under it.
- A DIFFERENTIAL HARNESS MUST FAIL LOUD ON A RUN THAT PRODUCED
  NOTHING. `su probe -c` could not execute a binary under the session
  scratchpad (0700 ancestors), so three mutations printed one
  permission error and no summary — and a `grep -E "fail| pass"`
  matched nothing, which read exactly like a clean pass (566). Every
  runner wraps its filter with an else branch that prints the tail and
  says NO SUMMARY; silence is never a verdict.
- `Bun.file(<a directory>).exists()` IS FALSE. Measured on Bun 1.3.11.
  So a guard written as `if (!(await Bun.file(p).exists())) continue`
  silently skips every path that names a directory — which masked the
  whole prefix arm of the invisible-literal refusal AND left a live
  stale hit: a gitignored DIRECTORY named in `cache.inputs.files`
  folds nothing and says nothing (item 565). Use a stat when the
  question is "is there something here", not `Bun.file`.
- THE PLATFORM ANSWER MAY ALREADY BE IN THE FILE YOU ARE TESTING.
  A row asserting a prune still evicts with its cache directory
  deleted went red on darwin: macOS answers `SQLITE_IOERR_VNODE` for a
  read through an unlinked vnode, and `close()`'s own catch had
  documented the WRITE half of that since it was written (item 564).
  Before writing a row that leans on an FS or syscall behaviour, grep
  the module for the symptom — the platform note is often three
  functions away — and prefer the claim that holds everywhere: here,
  that the scan reads the directory BEFORE it queries the index, so
  the failure never reaches SQLite.
