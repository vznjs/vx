# Shipped, 2026-09 — improvement-loop items 353–372

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
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`; items 373–392 in
`2026-09-improvement-loop-373-392.md`; items 393 onward
continue in `docs/STATUS.md`.

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
