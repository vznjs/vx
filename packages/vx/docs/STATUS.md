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
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, so this
file stays the handoff
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

353.  DONE (2026-09-19, flows.md and patterns.md — the two pages #451
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
354.  DONE (2026-09-19, comparison.md and parity.md — the pages I had
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
355.  DONE (2026-09-19, architecture.md — 660 lines, the page item 349
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
356.  DONE (2026-09-19, cli.md — 1918 lines, the last large unread
      doc and the one with the most machine-checkable surface). Its
      Flags table has been pinned to the parser since item 308; the
      VERB list never was, and that is where the fault sat: the
      `Top-level shape` synopsis, the ONE place the reference
      enumerates the verbs, had lost `vx why` and `vx last`. Both have
      full sections 1500 lines down, so nothing was undocumented —
      they were unreachable by scanning the index, which is how a
      reader finds a verb they do not already know. Everything else
      held: `migrate` and `prune` keep sections saying where they
      went, matching MOVED_VERBS exactly, and `stats` is named as the
      deprecated alias the dispatcher makes it. Two pins now, both
      differentially verified: every dispatcher case must have a
      synopsis line, and the synopsis may name no verb the dispatcher
      does not answer. The second direction is the one a doc rot
      produces — a verb removed from code, left in the index.
      Correction in the same commit: items 341–355 all read "DONE
      (2026-09-16" and were done on 2026-09-19; the 09-16 session
      ended at item 340, and I carried its date forward instead of
      reading the clock. Fifteen entries and thirteen test comments
      fixed in place. A date I did not verify is the same defect class
      as a cause I did not prove (the rule above item 297), and it is
      cheaper to check than any of them.
357.  DONE (2026-09-19, schema.md — 1375 lines, the config reference
      and the last of the three big core pages). Three faults, each a
      class the loop has already met once. (a) The page reprints ten of
      `src/config.ts`'s interfaces as fenced blocks; nine match field
      for field and `ExecConfig` had lost `remote`, documented in full
      two screens below the block that claims to be the interface —
      item 356's verb synopsis again, one page over. All ten are pinned
      both ways now. (b) The retry notice ends `after a timeout` when
      the kill was the timeout's and `after exit <code>` otherwise;
      schema.md and modules/execute-task.md both quoted only the
      second, the module page inside the same bullet that says
      "timeouts included". (c) A reflow had broken a sentence OPEN: the
      parenthetical "the count of names + the names themselves" wrapped
      so the plus landed at line start, and oxfmt made it a BULLET
      mid-sentence, which is how it shipped to the site. Item 299 fixed
      one span this formatter mangled and never grepped the class; the
      grep is a pin now — every paragraph and list item in every
      hand-authored page must close the parentheses it opens, which
      found this one and nothing else. The same sweep found a design
      page whose `### Tests (…` heading had wrapped out of its own
      heading; fixed, though design/ stays outside the class pins.
      Three pins, all three failing on the pre-fix pages. And a
      correction to how this loop reads its own gate: the first gate
      here went red on `lint.oxlint` (a `string | undefined` in the new
      pin) and my baseline comparison passed it, because that
      comparison diffs the failing TEST names and a lint failure is not
      a test. This container's baseline is 23 failing tests in ten
      failing TASKS; compare both sets, as the second gate did — its
      task set is byte-identical to the clean tree's.
358.  DONE (2026-09-19, caching.md — 1355 lines, the last of the big
      three). Its own suite is the best-covered on the shelf (the
      fingerprint file list, the invalidation table, both constants,
      and all ten SQLite tables with every column), and the checks that
      found faults elsewhere came back clean here: the SQL block still
      matches `cache.ts` exactly, the six file citations resolve, every
      quoted error message exists in source. Two faults, both in prose
      no test reached. (a) Step 3 explains the `fingerprint` seam by
      naming two plugins, and a rename to the one-package shape left it
      comparing `@vzn/vx-lockfile` to ITSELF — "`@vzn/vx-lockfile` folds
      the closure … `@vzn/vx-lockfile` is the same for `bun.lock`" —
      with neither helper named. It says `pnpm()` and `bun()` now,
      pinned to the package's exports and to the one `vx.workspace.ts`
      declares. (b) The `CACHE_VERSION` bump procedure listed
      "`CLAUDE.md` (decision log)", a section retired 2026-09-02, and
      left out STATUS.md: a bump done to the letter would have updated
      four of the six files and skipped the entry that says WHY. The
      list is the skill's list now, pinned to it. And the class the
      constants belong to had two unpinned members, both outside
      `packages/vx` where only the unsafe suite can read them: CLAUDE.md
      § Live invariants (which tells its reader to "verify in source
      before quoting" — an admission that it rots) and the bump skill
      itself, whose whole job is keeping this set consistent. Four
      pins; the two page pins fail on the pre-fix page, the two
      constant pins fail on a version one behind. One of them was
      written into the WRONG suite and the gate caught it: a pin that
      reads `vx-lockfile/src` and `vx.workspace.ts` cannot run in a
      shard, because a sandboxed task may read only its own project.
      Running the file directly passes it — unsandboxed — so a
      cross-package pin belongs in `tests/*.unsafe.test.ts` by
      construction, not by discovery.
359.  DONE (2026-09-19, execution.md — 551 lines, the runtime page
      beside caching.md). Its timeline holds against source: the
      dispatcher's fourteen verbs are all named, `--exclude-dependencies`
      is a real flag (my first grep said otherwise and I misread my own
      echo — the source settled it), the 2 s kill grace, the 8 MiB
      stdout head and tail, the twelve file citations. The fault is a
      GLYPH the renderer has never printed: `⦿ running`, listed in
      execution.md's grid sentence, in cli.md's glyph table as
      "running (worker row)", and in framed-output.ts's own docblock.
      A live worker row carries NO glyph — status-line.ts says so in
      the same breath, "the ticking time IS the motion" — so the one
      row the table attributes it to is the one row that has none.
      Item 302 struck a glyph a docblock invented and never grepped
      the class; this is the grep, and it found the class three deep,
      source comment included (a comment claiming what the code lacks
      is a defect, per the rule). Pinned: the six `glyphShape` emits
      plus `▸`, held at all three enumerations. And one more class
      caught short: the env allowlist is copied onto four pages and
      only schema.md's copy was pinned — the copy that had ALREADY
      drifted once. The other three are correct today and pinned now,
      with the fifth copy that lands unpinned no longer possible.
      Four pins; three fail on the pre-fix text, the fourth on a
      dropped name.
360.  DONE (2026-09-19, benchmarks.md and optimizations.md — the last
      two unread core pages, and the pair whose every claim is a
      measured number or a citation). Both hold up. optimizations.md's
      citations are already pinned (doc-references.test.ts); every bench
      script, env var and artifact benchmarks.md names exists
      (`BASELINE_ONLY`, `BUILD_SLEEP`, `DEPS_PER_PKG`, `CONCURRENCY`,
      `VX_BIN`, `--check`, RESULTS.md) and its internal arithmetic
      checks out (6.7× cold and 3.2× warm are the table's own rows).
      Two of my own greps nearly produced false faults and are worth
      recording as the same rule twice: `BUILD_SLEEP` is read as
      `process.env.BUILD_SLEEP`, which a `process.env['…']` scan cannot
      see, and item 359's `--exclude-dependencies` was declared missing
      by a scan whose output I misread. Both times the fix was to look
      at the source, not the scan. The one fault: § Profiling a run
      lists the `VX_TIMING` stage table in prose as an appositive that
      reads as the sequence, and named nine of the fourteen marks —
      `startup`, `workspace config`, `plugin stages`, `save lane` and
      `output dir snapshots` absent. modules/timing.md carries the same
      list and has been pinned to `prepare.ts` + `run.ts` all along; the
      sibling was not. It names all fourteen now, in order, pinned to
      the same source, and its span parenthetical says "among them" and
      points at the page that lists every one. One pin, failing on the
      old page.
361.  DONE (2026-09-19, the pins themselves). With the last core page
      read, the guards are the thing nobody had audited: 15 suites, 411
      assertions, 162 cases, and more than half of them in
      `site-samples.unsafe.test.ts` alone. Scanned for the shapes that
      make a test a silent pass. The derived-set pins are clean — four
      loops over a set built from source looked unguarded and all four
      assert the EXACT set first (`bins`, `methods`, `MOVED_VERBS`'s
      names), which is the rule working; recorded because a probe that
      refutes is worth the same as one that confirms. The CLASS pins
      are not. A class pin narrows the page list to "the pages that
      mention X" and then asserts something about them, so the day X is
      reworded the filter empties and the pin passes having checked
      NOTHING — which is precisely the drift it exists to catch. Four
      of them: the remote-seam grep (item 349), the `--frozen` figures
      grep (351), `exec.resources` (352) and my own retry-line grep
      (357) — the page-list floor was there, the filter's was not. Each
      one now names what it reached: the seam's twelve pages and the
      retry line's two by basename, the frozen paragraphs and the
      resources page list by count. Writing the membership down found
      that my estimate of the seam's class was three pages and the
      truth is twelve. All four verified by rewording the token they
      filter on: each passed before, each fails now. "A skip is a
      silent pass" was written here about tests of the code; it holds
      for the tests OF the tests.
362.  DONE (2026-09-19, § Next 8(c) — the last improvement-loop
      candidate still standing, and the first pin of this arc in the RUN
      path rather than the docs). The staged load
      (`orchestrator/projects.ts:loadProjects`, and `loadCliProjects`
      over it) is the config load every reader shares: plugin `project`
      stage run, cached evaluations served, the workspace a run itself
      sees. A raw `loadProjectConfig` sees none of it, so a reader that
      reaches for it answers from a DIFFERENT workspace than the one
      that runs — `vx info` missing a plugin's injected tasks is the
      case that made the note. Two uses are legitimate: `vx lock`, which
      must read raw and fresh because the lock IS the frozen evaluation,
      and the fallback each staged reader takes when the staged load
      THROWS, so one broken config cannot take a verb down. All five
      sites check out — doctor, select and watch each try the staged
      load and reach for the raw one only inside the `catch`; lock's two
      both pass the fresh flag. The rule was prose, and the instruction
      it carried (grep for the raw call before adding a consumer that is
      not a fallback) relied on someone doing the grep. The test is the
      grep now: the caller set is named, lock's calls must be fresh, and
      every other call must follow a staged attempt AND a catch. Three
      arms, all three verified — a new caller, a lock call without the
      fresh flag, a raw call above the staged one. The first pass of two
      of those arms was a FALSE negative: the new caller tripped the
      module-boundary rule instead of this one, and the "raw call" probe
      wrote the identifier with no parenthesis, which the pin's own
      regex does not match, so it passed and I nearly read that as the
      pin working. A probe's negative case is checked before its result
      is read — twice in one session now.
363.  DONE (2026-09-19, the module-boundary law — the second run-path
      pin, and one with a hole in it). Rule 1 forces a matrix decision
      for a new module that IMPORTS across a boundary: an unknown
      `fromModule` is a violation by construction. A new module that is
      only IMPORTED escapes BOTH rules — nothing adds it to
      `CONTRACTED`, so cross-module imports may reach straight into its
      internals — while the comment over that list says the ratchet
      covers "every directory module". A comment claiming what the code
      does not enforce is a defect by this repo's own rule, and this one
      sat in the file that enforces the rules. Both lists are held to
      disk now: `CONTRACTED` must equal the directories under `src/`,
      and `ALLOWED`'s keys the directories plus the root files. A new
      module of either shape fails until its author decides in the open;
      both arms verified with a probe directory and a probe file.
      architecture.md agrees with the matrix exactly — "eight modules
      plus three root files" is 7 directories + `config`, and the other
      three roots are bin/index/version — so the counts are pinned to
      the listing too, in words, with the table's rows held to the same
      set (the shape item 355 fixed one page over, caught here before it
      could rot). No fault on the page: the two describe different sets
      on purpose, eight contract surfaces against eleven matrix keys,
      and both now track the disk.
364.  DONE (2026-09-19, CLAUDE.md § Live invariants). I opened this
      expecting the four non-constant bullets to be unenforced claims,
      the way 362's staged-load rule and 363's ratchet comment were.
      WRONG, and worth saying plainly: all four are proven. The key
      derivation's strip and folds have `task-hash-derive.test.ts`,
      including a control that fails if the strip grows; the
      deadline-bounded flush, the crash-isolated sink and the warn that
      must accompany a never-fail path have `telemetry-lifecycle.test.ts`
      (four describes) and `layered-cache.test.ts`; the zero-cost gate
      has its own describe, which measures the git spawn by a named
      proxy (`.vx/workspace-id`, written only when the run context is
      built) and says so. The fifth bullet, "treat execute-task.ts as
      stale-hit-critical", is a posture, not a testable claim, and is
      left uncited on purpose. So the item is not the work I predicted:
      what was missing is the LINK. Every audit re-derives which suite
      proves which line by grep — I just spent the first half of this
      item doing exactly that — so each bullet now names its suite and
      the describes inside it, held by a pin. The pin's own first
      version failed on a name that wraps at CLAUDE.md's margin, which
      is item 355's "five\nlayers" hazard from the other side; both
      sides are compared with whitespace collapsed now. Its
      file-exists half duplicated the path pin two describes up, so it
      was cut — the new half is the describe. Two arms verified: a
      citation to a file that does not exist, and a describe renamed
      out from under one.
365.  DONE (2026-09-19, the split item 358 asked for and 361 measured).
      `site-samples.unsafe.test.ts` was named for byte-for-byte renderer
      samples and had become the home of every CLASS pin, because it was
      the only file already reading both doc trees: 1,475 lines, 226 of
      the suite's 411 assertions. That is why 358's pin landed in a
      sandboxed shard that cannot read `vx-lockfile/src`, and why 357's
      shared helper had to be added to a file about samples. The seven
      class greps now live in `tests/doc-class-pins.unsafe.test.ts` over
      one contract — `handAuthoredDocs()` for the page list,
      `CLASS_PAGES` for what each narrowing filter reaches — and
      site-samples keeps the 43 page-against-source samples it was named
      for (1,475 → 1,155 lines, plus 356 new). A move, not a rewrite,
      and held to that: 80 tests and 976 `expect()` calls before, 80 and
      976 after, across the two files. The shard machinery needed no
      edit — the shards filter `*.unsafe.test.ts` by suffix and the
      unsafe task globs the same suffix, so the new file is picked up
      and excluded by construction. Recorded because the carry went
      wrong twice before it went right: deleting the block ranges in
      ASCENDING order shifted every later one (the STATUS-cut rule, in
      a test file), and the second pass matched blocks by their text,
      which silently dropped one block's leading comment into its
      neighbour's match. The count check is what caught both — a move
      that loses an assertion looks exactly like a move that does not.
      One gate note, not swept: the first run failed
      `output-memory.test.ts`'s `none`-vs-`full` RSS case in shard-9,
      outside this container's baseline. It is an RSS HIGH-WATER
      measurement run beside eleven other shards on a four-core box —
      the class the rules above warn about — it passes 3/3 in
      isolation, shard-9 has gone red here before (the item-356 gate),
      and this diff touches only `*.unsafe.test.ts` files and STATUS,
      which no shard reads; a `.unsafe` addition does not change the
      shard deal either. Re-ran the whole gate once on an idle box: the
      failing-task set is byte-identical to the clean tree's. Recorded
      rather than re-run silently, because "it passed the second time"
      is not a root cause.
366.  DONE (2026-09-19, the baseline this arc gated against). Item
      365's stray RSS failure showed the set is not fixed, which means
      a real regression could hide inside its churn — so I stopped
      diffing against a number and characterised it. It is not two
      dozen unrelated flakes. TEN of the 23 are one cause, and the
      repo already says what it is: the container ships Bun 1.3.11
      against a declared floor of 1.4. `@vzn/vx-reapi` refuses to load
      and SAYS SO in its own error, `tar-stream` dies inside
      `Bun.Archive`, `project-loader` sees a `BuildMessage` its
      classifier does not know, the runner reads no `peakRssBytes`,
      and `bin.ts` truncates a 2 MiB pipe write to 219 KB — the exact
      defect the Rules section records as FIXED, which on this runtime
      it is not. Four more follow from that missing usage number,
      seven are the watch loop and `armWatcher` — which I attributed
      here to "the container's file notifications" and item 369 proved
      wrong: they are the floor too, so 21 of the 23 — and two pass
      3/3 alone and fail only under twelve shards. The
      upgrade is not available: `bun upgrade` is refused by this build
      and bun.sh answers 403 through the proxy, both tried. The
      controlled comparison is free and closes the attribution: CI
      pins Bun 1.4.2 and every PR of this arc went green there, same
      tree and same tests. Written
      into § In flight so the next session inherits a yardstick with a
      stated meaning instead of a number — and with the correction
      that matters for reading any gate in this arc: every green I
      reported was green against an out-of-contract runtime, which
      makes the comparison sound (same runtime both sides) and the
      absolute result meaningless.
367.  DONE (2026-09-19, the one finding from 366 that is not about a
      container). Core declares `"bun": ">=1.4"` in `engines` and reads
      it NOWHERE at run time: `engines` is advice an install may print,
      and `bun src/bin.ts` below the floor starts fine and then answers
      wrongly — a 2 MiB JSON write truncated to 219 KB, no
      `peakRssBytes` on any task, a config syntax error arriving as an
      internal error. `@vzn/vx-reapi` has guarded its own floor since
      2026-08; core, which is what a user runs without choosing a
      plugin, had nothing. `bin.ts` warns now, before the verb.
      I wrote it as a REFUSAL first, mirroring vx-reapi, and changed it
      on the evidence rather than on convenience. vx-reapi refuses
      because its failure mode is a hang, which leaves the user nothing
      to read; core's is a wrong answer, and 23 of ~2,000 tests failed
      below the floor, so most of core works there. Turning that into
      "the tool does not start" is heavier than the measurement
      supports. What the measurement supports is that a green exit can
      hide a truncated answer, so that is what the line says and the
      exit code is untouched. Worth recording that the refusal would
      also have blocked the gate that has to prove it — a design whose
      author cannot test it is a design to look at twice, but the
      reason to change it is the first one, not the second. Then the
      gate refuted the warning too, twice, and that is the part worth
      keeping. A line on stderr before every verb broke 19 tests
      holding one real property: a successful vx command writes NOTHING
      to stderr — and on CI, where the line never prints, those 19
      would have stayed green, so relaxing them would have been dead
      weight bought with a real assertion. Moving the verdict onto
      `vx info`'s bun ROW then broke a 20th, because `--format json` is
      a machine surface and a test holds that field to `Bun.version`
      exactly, which decorated prose violates. Final shape: `bun` stays
      the bare version, `bunSupported` is a typed boolean beside it,
      and the sentence appears only in the rendered row. Three designs,
      each discarded on evidence the repo's own tests supplied, none on
      taste. The survivor's cost is stated rather than hidden: a user
      who never runs `vx info` is not warned, proportionate to what was
      measured — wrong answers on an unsupported runtime, not a broken
      tool. Five tests; the doctor case asserts the verdict EXACTLY
      tracks `isUnsupportedBun(Bun.version)`, the same claim on 1.3.11
      and on CI's 1.4.2, and one case now holds the stderr property the
      first draft broke. Two repo guards caught my own gaps before the
      gate did: the page-per-module rule wanted
      `docs/modules/util-bun-version.md`, and the sandbox showed the
      doctor case reaching into a read-only checkout — it runs against
      a fixture workspace with its own cache dir now.
368.  DONE (2026-09-19, the loop item 367 opened). `MIN_BUN` now exists
      twice in code — core's `util/bun-version.ts` and
      `@vzn/vx-reapi`'s `wire.ts` — beside an `engines.bun` in every
      package manifest. Two lists, one source, in code and a build file
      rather than prose: the shape this arc has spent ten items
      pinning. The first question was whether they must AGREE, and they
      must not: a plugin may need a newer Bun than core, and these two
      are equal today for different reasons (core's floor is
      `Bun.Archive` and the answers that go wrong without it, the
      plugin's is an http2 client that hangs on its chunked uploads).
      What does hold is a relation: a code floor may sit above its
      package's declared `engines.bun`, never below, because a constant
      under its own manifest is a promise the package does not keep.
      That is Rule 6 in `package-boundaries.unsafe.test.ts` now, with
      the every-package-declares-it half beside it. One fix fell out
      rather than being excepted: `@vzn/vx-docs` declared no
      `engines.bun` at all, though it builds under `bun --bun astro
build` and this file records a Bun-specific hazard for exactly
      that command — it declares the floor now, so the rule has no
      exception to encode. Three arms: a manifest without the field
      fails, a floor below its manifest fails, and a NEWER floor
      passes, which is the arm that matters since the guard holds the
      relation and not the value. My own first comparison would have
      failed that third arm — a component-wise `some(n < e)` calls
      2.0.0 older than 1.9.0 on the minor — so the lexicographic helper
      proves itself on four pairs before the rule uses it.
369.  DONE (2026-09-19, the last group of the baseline resting on
      inference). Item 366 put seven failures — the watch loop and
      `armWatcher` — down to "the container's filesystem
      notifications". That was a plausible cause I had not proven,
      which this file's own rule forbids, and it was WRONG. The
      container is ext4 on a real block device with 130k inotify
      watches available, and a direct probe delivers `fs.watch` events
      in both recursive modes. What the probe then found is the actual
      rule: Bun 1.3.11 never reports a DOT-prefixed filename.
      `plain.txt` is delivered; `.dotfile`, `.vx-watch-probe` and
      `sub/.dotfile` are dropped, recursive and not. `armWatcher`
      proves a watcher is live by writing `.vx-watch-probe` and waiting
      for its event, so below the floor that proof can never arrive.
      The baseline is 21 of 23 the runtime now, and the two
      `--continue=always` cases are the whole of what load explains.
      Both wrong entries are corrected in place, 366's and the § In
      flight note's. Nothing to fix in the code, and that is a finding
      too: the loop already swaps `pollWatcher` in when readiness is
      not proved and writes a line saying it is polling, so on such a
      runtime `vx watch` degrades loudly instead of watching nothing —
      the design anticipated a filesystem that reports nothing and this
      is one. Recorded as a fourth measured breakage in
      `modules/util-bun-version.md`, beside the three item 366 found.
      No test: "Bun drops dotfiles" is a claim about a runtime below
      the floor, and asserting it would fail on CI's 1.4.2, where the
      events arrive.
370.  DONE (2026-09-19, the shard deal — the first thing this arc has
      touched about the gate's SPEED rather than its truthfulness, and
      two more of my hypotheses refuted). 37 gate logs had accumulated
      this session, so the measurement was free: per-shard medians
      spread 3.06×, from shard 11's 21.2 s to shard 1's 64.7 s, against
      an average shard of about 29 s. The stage waits for the slowest,
      so the suite pays 64.7 s for an average of 29 s. My stated
      hypothesis was that the recorded deal had drifted. It has NOT:
      shard 1 carries 13,622 of a 159,139 total against an ideal 13,262
      — within 3% — and the existing balance test (heaviest shard
      within 1.25× of the lightest) passes. Second hypothesis, that the
      inflation is `armWatcher` burning its 2 s readiness timeout per
      watcher below the Bun floor: also refuted, by measuring
      `VX_WATCH_POLL=1` against the native path on the heaviest file,
      54.9 s vs 48.9 s. What is left, and fits: the file's tests FAIL
      here, and a watch test that fails does so by timeout, burning its
      whole window — the floor again, through the failures rather than
      through the arm. Nothing to fix in the dealer, and CI corroborates
      it. What the measurement did surface is a bound nobody guards: a
      file is INDIVISIBLE, so once its own weight passes the ideal
      per-shard load no deal can place it anywhere cheaper and the fix
      is splitting the file, not re-dealing.
      `watch-loop-uncached.test.ts` is at 79% of that today. Pinned,
      and the differential proves it catches what the balance test
      cannot: set the heaviest file to 1.2× ideal and the old test
      still passes while the new one fails.
371.  DONE (2026-09-19, `design/pipeline-2026-09.md` — the seam
      contract CLAUDE.md cites and the one major document this arc
      never read). It is marked "shipped", so its rules read as
      current, and Rule 5 says a workspace with no `executor` or
      `cache` "fails before any task runs, naming the fix". That is
      the shape the project REJECTED. `plugin-host.ts` pushes
      `localExecutor()` as the TAIL of every list and the local store
      ends every cache chain, so a workspace with no `vx.workspace.ts`
      runs and caches — principle #7's local floor, stated in CLAUDE.md
      and contradicted by the page CLAUDE.md sends you to. Rule 5 is
      struck and marked superseded now, with the half that still holds
      kept (core NAMES no plugin; a capability a plugin must supply is
      declared or it does not exist). Its status line was wrong the
      other way: it said the verb move-out "remains", when the move-out
      happened and differed from the plan — `vx migrate` went to
      `@vzn/vx-migrate`, `vx prune` was REMOVED rather than moved,
      `vx upgrade` stayed in core, `@vzn/vx-cli-extras` never existed,
      and core's verb list is thirteen where the design predicted
      eight. The line says that now and points at `src/util/verbs.ts`.
      The grep found one sibling, `plugin-executor-reapi-2026-08.md`,
      which describes the same rejected shape down to
      `localExecutorPlugin()` under `src/plugins/` — a directory a test
      asserts does not exist. Left alone deliberately: rewriting the
      record of a rejected shape would destroy the evidence that it was
      considered. CORRECTED by item 372: I justified that with "nothing
      cites it as live", and `docs/modules/executor.md` does cite it
      (§ 4, for an `outputs` discriminator a later design still owes).
      The decision stands — the citation is to the half that shipped —
      but the reason I gave was a fact I had not checked. The difference is that
      CLAUDE.md points at the 2026-09 page and calls it the design.
      Pinned both ways: while `executors.push(localExecutor())` is in
      the source, Rule 5 must carry its strike — and if the floor ever
      leaves, the pin fails too, so the note gets revisited instead of
      quietly outliving what superseded it.
372.  DONE (2026-09-19, the `docs/design/` shelf — 31 documents, and
      the question item 371 raised). A stale design doc is a fine
      RECORD and a dangerous CONTRACT, and the difference is whether
      live documentation promotes it. Seven do: CLAUDE.md and six live
      pages cite `pipeline-2026-09`, `module-isolation-2026-06`,
      `config-lock-2026-06`, `turbo-nx-test-gaps`,
      `download-policy-cas-cache-2026-08`,
      `plugin-executor-reapi-2026-08` and `resource-estimates-2026-09`.
      Five already say what became of them (shipped, complete,
      proposal, or a dated survey). Two did not, and one of those is
      the doc I dismissed in 371 as uncited — `modules/executor.md`
      cites it for the `outputs` discriminator, so my stated reason was
      a fact I had not checked, corrected in 371's entry in place. It
      has a status line now, because three of its claims are false
      today: the local plugins under `src/plugins/` (a directory a test
      says cannot exist) were replaced by the FLOOR, the `backend`
      capability was removed, and vx-cloud, which the design says "is
      NOT deleted … it coexists", is gone and on the rejected list. The
      seam itself shipped, and the citation points at that half.
      `turbo-nx-test-gaps` needs nothing: it opens "Generated:
      2026-05-17" and reads as the survey it is. The remaining 24 are
      untouched on purpose — an uncited design is a record, and
      rewriting the record of a rejected shape destroys the evidence it
      was considered. Pinned: a design doc a live page or CLAUDE.md
      cites must state its status. Both arms verified, and the second
      is the one that matters — pointing a live page at a previously
      uncited design fails the pin, so the next promotion to "current"
      is caught at the moment it happens. The gate earned its keep
      again: the pin passed under `bun test` and failed
      `lint.oxlint`, because `Bun.Glob.scanSync` yields an ITERATOR and
      `.map` on it is a type error a transpile-only run cannot see —
      the rule at the top of this file, met for the second time in this
      arc.
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

## In flight

**The gate's baseline in a cloud container (2026-09-19).** A session
that gates somewhere other than a dev box will see `vx run ci --all`
come back red with roughly two dozen failing tests and ten failing
tasks, and diffing against that set is only honest once the set has a
cause. On the 2026-09-19 container the cause is mostly ONE thing: the
box ships **Bun 1.3.11** while both `package.json` files declare
`"bun": ">=1.4"` and this repo names `Bun.Archive` a hard dependency.
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
   run-path change.

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
