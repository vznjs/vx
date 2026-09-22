# Shipped, 2026-09 — improvement-loop items 493–512

The record `docs/STATUS.md` carried until 2026-09-22, moved here whole
when the loop reached one hundred and twenty entries (item 573). A PREFIX,
as item 373 set the rule: the formatter renumbers an ordered list
sequentially, so a cut from the middle would renumber every entry below it
and break the cross-references that cite item numbers here, in STATUS and
in the test comments.

Items 1–64 in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`, items 353–372 in
`2026-09-improvement-loop-353-372.md`, items 373–392 in
`2026-09-improvement-loop-373-392.md`, items 393–412 in
`2026-09-improvement-loop-393-412.md`, items 413–432 in
`2026-09-improvement-loop-413-432.md`, items 433–452 in
`2026-09-improvement-loop-433-452.md`, items 453–472 in
`2026-09-improvement-loop-453-472.md`, items 473–492 in
`2026-09-improvement-loop-473-492.md`; items 513 onward continue in
`docs/STATUS.md`.

493.  DONE (2026-09-20, `graph/scheduler.ts`, 745 lines — picked by
      COST: a scheduling bug is a wrong-ORDER run, which finishes
      green and only costs wall time, and perf is driver #1 here).
      Seven mutations. Four caught, three survived, and two of the
      three were real holes.
      CAUGHT: `aborted` dropped from the skip propagation fails two
      rows, one naming the consequence exactly ("does not let its
      dependents cache what they built from its partial outputs") —
      that one is stale-hit class and it is pinned. The skip chain's
      root (`blocker ?? viaSkip.blockedBy`) fails its own row. The
      heap's tie-break (`seq[i] < seq[j]`) fails SEVEN. The restore
      lane's 2× cap fails two, one of them a docs-drift row.
      HOLE 1 — the priority closure. `computeReverseDepCount` counts
      TRANSITIVE dependents with a bitset closure over a reverse-topo
      sweep, deduplicated so a diamond is not double-counted. Delete
      the fold — making it a DIRECT dependent count — and the whole
      suite passes. Its only direct row TIMES it (the perf floor); its
      only other mention is a docs-drift row reading its source text.
      Its behavioural witnesses are the two ordering rows above it,
      and both use CHAINS, where direct and transitive counts rank
      identically. So the transitivity the function exists for had
      nothing on it.
      Fixed with the two shapes that separate them. A diamond +
      chain (root → {a,b} → c → d → e) where three answers are
      distinguishable and only one is right: 2 is root's direct
      count, 8 is what naive summing reports (measured, not
      assumed — a and b each re-report c, d and e), 5 is the closure.
      And the consequence end to end, on the one shape where the two
      counts disagree about ORDER: a wide shallow fan-out (direct 3,
      transitive 3) against a five-deep chain (direct 1, transitive
      5), with the wide one inserted first. A direct count runs the
      fan-out first and leaves the chain to unwind at the end of the
      run, which is the idle tail the heuristic exists to avoid.
      Both rows redden on the dropped fold, and — unplanned — they
      also redden when the reverse-topo sweep runs FORWARD, which
      nothing had held either.
      HOLE 2 — `mergePriorities`'s scale. An override is multiplied by
      1<<20 before the baseline is added as a tie-break, so a scored
      node outranks every unscored one whatever their reverse-dep
      counts; that is what makes the `schedule` seam's weights
      DECIDE. Drop the scale and the suite passes, because the one
      row that scores nodes scores four independent roots whose
      baseline is 0, where `w * SCALE + b` and `w + b` rank the same.
      Pinned with the smallest override a caller can express (1)
      against an unscored node that blocks five others: unscaled, 1
      loses to 5.
      SURVIVOR, classified REDUNDANT — the parked-repush's original
      seq. A parked task is repushed with the seq it was popped
      under; dropping that (a fresh seq) is caught by nothing, and
      nothing CAN catch it, because it changes no order: `parked` is
      a subsequence of the tick's pop order and so is already in
      ranking order, and every later push takes a later seq, so fresh
      seqs handed out in parked order reproduce the same ranking.
      Measured over 800 randomized scenarios — random DAGs, costs,
      budgets, concurrency, failures, all three continue modes — zero
      order differences. Kept (it makes FIFO-among-equals a property
      of the heap instead of of the tick loop's shape), but the
      comment claiming a fresh seq "would demote it behind later
      arrivals" is now de-claimed, and the row titled "(original seq
      preserved)" is retitled to what it actually pins: the order.
      Method note: holes 1 and 2 are ONE shape, and it is 491's —
      a witness whose FIXTURE cannot separate the implementation
      from a wrong one. 491 was a fixture missing an entry, these
      two are fixtures whose graphs make two different answers rank
      identically. Chains hide transitivity; zero baselines hide a
      scale. When a claim is about an ORDERING, the fixture has to be
      the shape where the wrong rule orders differently — a fixture
      where both rules agree is a test of neither.

494.  DONE (2026-09-20, `graph/task-graph.ts`, 625 lines — the other
      half of the graph module, and stale-hit/data-loss class: a wrong
      edge folds a wrong upstream key, and two tasks claiming one
      output delete each other's work under a green summary). Nine
      mutations, EIGHT caught, and the file earns the held report —
      it is the best-pinned surface swept so far, which is what 441,
      442 and 445 bought.
      Caught, each by rows naming the claim: dropping either direction
      of the literal-vs-glob comparison (8 rows), the identical-globs
      case (7), the deps dedup, the deps sort, the origin seeding the
      package-cycle `visited` set (5), walking past the nearest holder
      (3), and both of `markSurfacedDeps`'s stated hard limits — one
      row each, exactly named.
      THE SURVIVOR is `isLiteralGlob`, and it is a hole with the worst
      consequence in the file. The refusal turns on CLASSIFYING a
      spelling as literal or glob: classified literal, a pattern is
      compared by string equality, never matches the file it actually
      claims, and the collision is allowed through — so the two tasks
      clean each other's outputs on every run and the run reports
      success. Narrow the classifier from `[*?[\]]` to `[*]` and the
      WHOLE SUITE passes, because every fixture in the file spells its
      wildcard `*`. Measured on the predicate: `dist/a?.txt` vs
      `dist/ab.txt` and `dist/[ab].txt` vs `dist/a.txt` both go
      true → false, while `Bun.Glob` matches both pairs — so the
      globs really do claim those files.
      Pinned one character at a time, with a control: `?` over a
      matching literal, a character class over a matching literal,
      both in either declaration order, plus a CONTROL that neither
      refuses a literal it does not match (without it the rows would
      also pass on a rule that refused any pair containing a `?` or a
      bracket). Differential per character: narrowing to `[*]` reddens
      both rows, narrowing to `[*?]` reddens only the character-class
      one.
      Method note: this is 493's shape a third time, and the sharpest
      instance yet — not a graph whose shape makes two rules agree,
      but an ALPHABET. Every fixture wrote its wildcard the same way,
      so the classifier was only ever asked about one of the three
      characters it classifies. When a predicate switches on a SET of
      spellings, the fixtures have to spell it every way the set
      allows, and one row per member is what makes the mutation of
      each member visible.

495.  DONE (2026-09-20, `util/paths.ts` + `cache/inputs.ts` +
      `graph/task-graph.ts` — 494's method found a LIVE defect, not a
      testing gap, one file over). Applying 494's lens to
      `cache/inputs.ts` started with its own literal-vs-glob
      classifier, `isLiteralPath`, and the first thing it showed was
      that its character set is `[*?[\]{}]` while the one 494 had just
      pinned in `graph/task-graph.ts` was `[*?[\]]`. Same question,
      two answers, and the SMALLER set is the one deciding a refusal.
      Measured on shipped code before any change:
      `Bun.Glob('dist/{a,b}.txt').match('dist/a.txt')` is true, and
      `outputsOverlap('dist/{a,b}.txt', 'dist/a.txt')` was FALSE. So
      two tasks, one declaring the brace pattern and one declaring the
      file it matches, were accepted by the graph builder and then
      cleaned each other's outputs on every run, green. That is the
      exact hazard `detectOutputCollisions` exists to prevent, live,
      and 494's new rows did not reach it because braces were a
      fourth spelling nobody had tried.
      There were FOUR copies of the predicate: `util/paths.ts`
      (private, behind `asTrees`), `cache/inputs.ts` (private,
      identical), `normalizeGlob`'s own inline `/[*?[\]{}]/`, and
      task-graph's smaller one. One rule, one place now:
      `isLiteralPattern` is exported from `util/paths.ts` and all four
      sites read it — the same remedy `asTrees` got in 442 and
      `outputsOverlap` got in 445, for the same reason.
      Pinned member by member. `isLiteralPattern` gets a row per
      wildcard character (star, globstar, `?`, both brackets, both
      braces) plus a control that an ordinary path is still a literal
      — without the control the rows also pass on `() => false`, which
      would strip every literal of its subtree and reopen 442 from the
      other side. The collision table gains the brace pair and its
      non-matching control. Differential per character: narrowing the
      class to `[*]` reddens 8 rows, `[*?]` reddens 6, `[*?[\]]` — the
      exact classifier that shipped — reddens the 3 brace rows, and
      `[*{}]` reddens the 5 `?`/bracket rows. Every member is load-
      bearing and every member is visible.
      NOT fixed here, recorded as the next target: the same predicate
      is written out four more times in `exec/sandbox-runtime.ts`,
      `exec/sandbox-binds.ts` and `orchestrator/sandbox-request.ts`,
      each with `[*?[\]]` and no braces, while
      `orchestrator/stable-keys.ts` carries the full set. Those answer
      a DIFFERENT question — whether a bind spec needs a directory
      walk — so a wrong answer there is a task that cannot read its
      file rather than a silent deletion, and it deserves its own
      measurement rather than a speculative edit riding this one.
      Method note: 494 said "when a predicate switches on a set of
      spellings, spell it every way the set allows". 495 is the
      correction that rule needed: FIRST check whether the codebase
      agrees on what the set IS. The gap was not that a test forgot a
      character — it was that two functions answering one question had
      drifted, and the test could only ever be as complete as the
      narrower one.

496.  DONE (2026-09-20, `exec/sandbox-runtime.ts` — 495 named the three
      sandbox copies of the literal-vs-glob predicate as the next
      target, and the measurement said DON'T unify them). Probed
      before touching anything: a real sandboxed workspace, one task
      per grant spelling, each writing the files it declares.
      `g/**` ok (collapses to the directory), `g/a.txt` ok (a
      file-shaped grant, widened to its directory), and `g/*`,
      `g/*.txt`, `g/?.txt`, `g/[ab].txt` ALL FAILED with
      `bash: g/a.txt: Read-only file system`.
      That is the documented contract, not a defect: `expandGrants`
      says a bind "covers what exists when the task STARTS… declare
      its directory instead". What it is not is DISCOVERABLE — the
      failure names neither vx nor the grant, and it is the user's own
      tool reporting it, the same shape as the `bun build --compile`
      network-error confusion in item 247.
      So the report, not a behaviour change: a write grant that
      expands to nothing says so once, before the task runs, and names
      the directory to grant instead. The remedy is `staticPrefix` —
      the directory the pattern was IN — and deliberately not the
      scan's anchor, which is one component higher (`dirname` of the
      literal head, so the relative pattern keeps its wildcard) and
      would tell the user to grant the parent of what they meant.
      Reads are NOT reported: a read grant matching nothing is
      ordinary (an optional file, a cache not yet populated).
      AND THE 495 FOLLOW-THROUGH IS REFUSED, on the measurement.
      `write: ['g/{a,b}.txt']` SUCCEEDS today — the classifier here
      counts only `*?[]`, so a brace grant is treated as a file,
      placed, and widened to its directory. Giving this site the
      shared `isLiteralPattern` would move that spelling into the scan
      and turn a working grant into `Read-only file system`. The two
      predicates answer different questions: whether a declaration
      must be MATCHED against other declarations (495), and whether a
      grant can be MOUNTED (here). Both sites now say so, so the next
      sweep does not "finish" 495 by regressing this.
      Three differentials, all red: deleting the report, reporting
      READS as well, and naming the parent directory as the remedy.
      Method note, and it cost a round: the read CONTROL was INERT the
      first time. The report is once per grant PATH, and the control
      reused `g/*.txt` — the same path the write row had just
      reported — so the warn-once set silenced it and the
      "reports reads too" mutation passed. A control that shares
      state with the row it controls is not a control; it now uses a
      different pattern, and the mutation reddens. That is 483's "one
      control sample is not a control" in a new costume: here the
      sample was distinct but the MEMO was not.

497.  DONE (2026-09-20, `cache/inputs.ts`'s `ALWAYS_IGNORE` — a SET, so
      swept member by member, which is 494's rule applied to a list
      rather than to an alphabet. A wrong input set is stale-hit
      class, and this list's job is keeping a dependency tree out of
      every cache key). Six members, six separate mutations:
      node_modules 8 rows, vx-lock.json 8, .vx 6, *.bun-build 6,
      *.tsbuildinfo 5 — all with behavioural rows that name them,
      because two table-driven rows quantify over the list and a third
      asserts the FIXTURES cover every member (the restated-list guard
      from items 400/401, doing its job).
      `**/.git/**` is the one that isn't. It reddens THREE rows and
      all three are meta: the fixtures-cover-the-list self-check and
      two docs-drift rows quoting the list. No assertion anywhere
      changes when it goes.
      Classified DEFENSIVE, and proven rather than assumed — probed
      three routes with the pattern in and out: a tracked `**/*` glob,
      an UNTRACKED one, and a literal `inputs.files: ['.git/HEAD']`.
      Identical every time. Git never reports a path under `.git`, so
      the enumeration is the live guard; the literal route does not
      even reach this list (it is refused by the git-reports-it check,
      with its own message). The CONTROL that makes that meaningful:
      an untracked ORDINARY file in the same fixture DOES enter the
      set, so the enumeration is not simply ignoring what is
      untracked.
      Kept, and the reason is now written where it lives: the day an
      enumeration stops going through git, this is what keeps a
      repository's object store out of a cache key. No test added —
      nothing can distinguish it today, and a row that cannot fail is
      the thing this whole sequence exists to remove.
      Method note: the table row DOES plant `.git/HEAD` and assert it
      is excluded, so the member looks covered. It passes either way.
      That is 493's and 494's shape once more, and the cheapest tell
      yet: when a set is swept member by member, the member whose
      only red rows are the LIST ASSERTING ITSELF is the one with no
      behavioural witness.

498.  DONE (2026-09-20, `cache/git-inputs.ts`'s `parseStatusOutput` —
      497 proved git's enumeration is the LIVE guard that made
      `**/.git/**` redundant, and the enumeration itself had never
      been swept). Started with the two set-valued predicates there,
      member by member. `autocrlfConverts` is pinned exactly: dropping
      `'input'` fails "is true only for the values that actually
      convert".
      The rename/copy branch is not. `x === 'R'` and `x === 'C'` both
      survive on their own, and so does removing the branch outright —
      nothing in the suite changes.
      Classification took three probes and the first reading was
      WRONG. Measured: for a rename the source has left the index, so
      it never had a trusted OID to delete; for a copy (which git only
      reports under `status.renames=copies`, and only when the source
      is ALSO modified — measured both) the source is separately
      reported `M` and is already dirty. So `dirty.add(source)` is
      indistinguishable in both reachable states, and on that reading
      the whole branch looked like 497's `.git` again.
      It is not. The branch's real job is CONSUMING the source token,
      and that is load-bearing: unconsumed, the loop reads the source
      path as a status line of its own and adds `slice(3)` of it to
      the dirty set. `'orig.txt'.slice(3)` is `'g.txt'` — a real,
      clean, entirely unrelated file, which then loses its trusted OID
      and is rehashed from the worktree, its key part flipping
      representation for the duration of somebody else's rename.
      Measured end to end: `trusted` is `[g.txt, other.txt]` with the
      branch and `[other.txt]` without.
      Pinned with a bystander: a root-level rename plus a tracked
      `g.txt`, asserting the bystander keeps its index OID, with a
      CONTROL that the rename's own target does NOT (so the row cannot
      pass on an enumeration that trusts everything). Both
      differentials red — removing the branch, and keeping the branch
      but not the `i++`.
      Note the existing row "staged rename drops trust on both sides"
      cannot see any of this: it has no bystander, and its `old.ts`
      half holds either way, since a renamed-away path has left the
      index and never had an OID to lose. Half of a two-assertion row
      was already vacuous.
      Method note: this is the first survivor in the sequence where
      "redundant" was the WRONG answer, and the thing that caught it
      was refusing to write the conclusion before probing the third
      state. The `dirty.add` half really is redundant; the branch
      containing it is not. A guard can be load-bearing for a reason
      that is not the one its code appears to be about — so a survivor
      is classified by what BREAKS when it goes, never by what it
      looks like it does.
      Also swept clean in the same pass: `resolveInputs`' boundary
      rules (3 rows on the outputs side, 7 on the inputs side,
      principle 6 well held) and the own-outputs exclusion (10+ rows).

499.  DONE (2026-09-20, `git-inputs.ts`'s `parseLsFilesOutput` — the
      mode set the OID fast path trusts, swept member by member).
      `100644` and `120000` each fail rows in `git-oid.test.ts`.
      `100755` — EXECUTABLE — fails nothing, whole suite. Every
      `scripts/*.sh` in a repo loses its trusted index OID and goes
      back through `hashFile`, so its key part flips representation
      and the read the fast path exists to avoid happens anyway. COST,
      not correctness (dropping an OID is the safe direction), and
      pinned because executables are not exotic.
      Pinned as one exact object over the three modes plus the gitlink,
      so a dropped member names itself. Three differentials red, one
      per mode.
      THE HONEST PART: my first version called the gitlink line a
      CONTROL, and it is inert. Measured: adding `160000` to the
      trusted set leaves `sub` without an OID anyway, with or without
      a directory on disk — a second mechanism downstream keeps a
      non-file out of the map. It is now labelled a recorded fact
      rather than a guard. That is 496's inert-control trap, caught
      in my own new row this time, one item after writing the rule
      down.
      AND A HARNESS DEFECT, which is the more useful find: two of the
      three mode mutations were reported as SURVIVING by the sweep and
      both were lies. The loop packed "replacement|tag" into one shell
      variable and split it with `%%|*` — but the replacement contains
      `||`, so the payload was truncated mid-expression and the file
      no longer parsed. The whole-suite verdict then showed no new
      failing NAMES (a file that cannot be imported emits no `(fail)`
      rows at all) and I read that as "nothing caught it".
      Caught by running the one file directly, which is the check that
      should have come first: `100644` dropped fails three rows there
      in under a second. New rule, earned: a mutation that SURVIVES is
      confirmed against the single most-relevant test file before the
      whole-suite verdict is believed, because an empty NEW list means
      either "nothing caught it" or "nothing ran", and those look
      identical. And never pack a payload containing `|` into a
      `|`-delimited loop variable — the repo already has this lesson
      for `pkill -f` patterns matching their own shell.

500.  DONE (2026-09-20, `git-inputs.ts`'s `gitPathspecs` — four
      conjuncts deciding whether git scans a handful of directories or
      the whole tree, and the function had NO direct row: the only
      mention of it in the tests was a header comment).
      Swept clause by clause. `!workspaceWide` is pinned elsewhere (2
      rows in the workspace-wide partition suite) and the
      project-is-the-root guard is pinned hard (8+ rows, including the
      boundary and stale-hit suites). The `> 0` guard and the `<= 64`
      CAP are not: moving the cut to 63, or removing it entirely,
      passes the whole suite.
      That is expected and it is why the cap needed a row anyway: both
      sides of a perf boundary are CORRECT, so no behavioural test can
      ever separate them, and the number stops being a decision and
      becomes a coincidence. It is a measured decision (75 ms → 11 ms
      scoped on an 11k-file repo; above the cut the arg and exec
      overhead wins), so the row asserts BOTH sides — 64 dirs still
      scope, 65 do not.
      Five rows now, one per clause, each reddening alone: scoped,
      workspaceWide, no projects, project-is-root, and the cap. Five
      differentials, five singles.
      Method note, correcting 499's new rule in the same breath it was
      written: the fast single-file pre-check said all five clauses
      survived, and TWO of them were pinned — in other files. So the
      pre-check is a filter for whether to BELIEVE a survivor, never a
      substitute for the verdict: it can only say "not here". 499's
      rule stands in the direction it was written (a survivor is
      confirmed against the obvious file before the verdict is
      trusted), but the converse does not follow, and I acted as if it
      did for one step.

501.  DONE (2026-09-20, `git-inputs.ts`'s `dropFilteredOids` — the
      clean-filter gate, and the worst failure class in the repo:
      an index OID is the FILTERED blob, so trusting one where a
      `text`/`eol`/`ident` filter applies folds the SAME key for the
      CRLF and the LF state).
      The gate first asks whether any attributes source exists at all,
      and there are three. `attributesAbove` (the walk added for the
      measured `--filter` stale hit) is pinned by its own row. The
      other three conjuncts — the in-tree `.gitattributes` scan,
      `core.attributesFile`, and `$GIT_DIR/info/attributes` — ALL
      survive the whole suite. Three stale-hit holes in one function.
      Each proven reachable, one placement per source (`a.txt`
      trusted, false is correct):
      in-tree scan dropped → a `pkg/sub/.gitattributes` goes
      false → TRUE; `core.attributesFile` dropped → a user-global
      attributes file goes false → TRUE; `info/attributes` dropped →
      the repo-local one goes false → TRUE.
      And the first classification was WRONG AGAIN, which is now the
      third time in this sequence. The in-tree scan looked REDUNDANT:
      with `.gitattributes` at the project dir, dropping the scan
      changed nothing, because `attributesAbove` walks repo-root →
      project and finds it there. The deeper placement is what
      separates them — BELOW the project dir nothing else looks — and
      only probing that state turned "redundant" into a hole.
      Pinned as three rows, one per source, each with the placement
      that isolates it and a CONTROL in the same repo (a `plain.md`
      the filter does not name keeps its OID, so no row can pass on a
      gate that distrusts everything). Three differentials, each
      reddening its own row alone.
      Also swept and pinned already: `parseCheckAttrOutput`'s value
      pair (`unspecified` 2 rows, `unset` 1).
      Method note: 496, 498 and 501 are now three straight items where
      the FIRST probe supported "redundant" and a second placement
      refuted it. The pattern is specific enough to name: when a guard
      looks redundant because a LATER guard also covers the case,
      check whether the later guard's reach is NARROWER somewhere —
      a walk that stops at a directory, a check that needs a file to
      exist, a detection that needs a modified source. The overlap is
      usually partial, and the part that does not overlap is the whole
      reason the first guard is there.

502.  DONE (2026-09-20, `cli/watch.ts`'s event filters — the half 482
      left, where a wrong answer is a watch that silently stops
      re-running or one that never settles).
      Both ignore SETS are pinned member by member:
      `IGNORED_SEGMENTS` (node_modules 3 rows, .git 1, .vx 2) and
      `IGNORED_SUFFIXES` (.tsbuildinfo 1, ~ 1). `watch-rules.test.ts`
      has a table row per member, which is what 494 and 497 had to add
      elsewhere — this file already had it.
      `makeRootEventFilter`'s clauses: the fingerprint arm (3 rows),
      the workspace-config arm (2), the glob arm (3) and the
      negations-are-not-consulted filter (7) all fail when dropped.
      THE ONE SURVIVOR is the depth test, `!rel.includes('/')`, and it
      is REDUNDANT — measured this time before writing it down, over
      eleven spellings including `nested/bun.lock`, `./bun.lock` and
      `a/b/c/pnpm-workspace.yaml`: every answer identical with the test
      removed. Both predicates it guards are exact membership in a set
      of BARE names, so a `rel` carrying a slash cannot be in one.
      Kept as a reading aid and now says so.
      Worth the note it got in the test table: the two rows that LOOK
      like they pin it (`nested/pnpm-lock.yaml → false`,
      `nested/vx.workspace.ts → false`) pass either way. What they
      really pin is that the predicates stay EXACT — a basename or
      suffix match would fail them, and that is the change that would
      make the depth test load-bearing. Same shape as 498's vacuous
      half, found on purpose this time rather than by accident.
      Method note: 501 said to check whether the later guard's reach is
      narrower somewhere before calling the earlier one redundant.
      Here the later guard's reach is strictly WIDER — set membership
      rejects everything the depth test rejects and more — which is
      the case where "redundant" is the right answer. The rule cuts
      both ways, and the check is what tells them apart.

503.  DONE (2026-09-20, `cli/watch.ts`'s timing helpers — the part of
      the file 502 did not reach, where a wrong answer is a DROPPED
      edit and the watch just sits there looking alive).
      Four of five pinned: `modifiedBefore`'s unreadable-path arm (an
      ENOENT is never "before"), `fsClockNow`'s stamp read (taking
      `Date.now()` instead of the stamp's own mtime), and both of
      `pendingAfterCycle`'s clauses (first label wins; an abort
      returns nothing) each fail a row.
      THE SURVIVOR is `modifiedBefore`'s comparison itself: `<` → `<=`
      passes the whole suite. The row that covers this function
      asserts an mtime BEFORE `t`, an mtime after it (`t - 1`), and an
      unreadable path — never `t` EQUAL to the mtime, which is the
      boundary the operator names.
      It is not an exotic case, and that is the point: `fsClockNow`
      exists because an mtime is the kernel's COARSE clock, and it
      reads the arm instant off a stamp file's own mtime. A write
      landing in the same tick therefore carries exactly that value.
      So equality is a case this clock CHOICE creates, and `<=` calls
      such an edit "made before the arm" and drops it — precisely the
      silent missed edit the stamp machinery was built to prevent
      (the 2026-09-11 watch e2e flake).
      Pinned in place: one line asserting the exact-equality case,
      beside the two strict ones already there. Differential red.
      Method note: this is 491's shape — a boundary asserted on one
      side only — and it keeps recurring because a fixture naturally
      reaches for `t - 1` and `t + 1`. Both of those pass under either
      operator. The value that separates them is the one nobody
      reaches for, and for a comparison the rule is now simply: assert
      AT the boundary, not around it.

504.  DONE (2026-09-20, `cache/cache.ts`'s SCHEMA_VERSION reset — the
      DROP list, swept as a LIST. The hazard is a table added later and
      left out of it: stale rows under a new schema, read by code that
      assumes they match).
      First the list against the schema. Three tables the schema
      CREATES are not named in it — `schema_meta`, `output_dirs`,
      `config_closures` — and one name in it, `run_task_inputs`, is
      created nowhere (a leftover, harmless under IF EXISTS, and worth
      keeping so an old DB still loses it).
      Measured what actually survives, planting a row in every table
      and forcing a reset:
      `schema_meta` survives and must (it holds the sentinel the gate
      just wrote). `output_dirs` does NOT survive despite being
      unnamed — with foreign_keys on, DROP TABLE fires the ON DELETE
      CASCADE from its `entries(hash)` reference. `config_closures`
      DOES survive, and that is safe rather than lucky: a closure is a
      stat-index feeding config key derivation, so a stale one changes
      the KEY (a miss, then a rewrite), never the answer.
      So the DROP list is not the mechanism it looks like. Differential
      per member: removing `runs`, `file_hashes`, `invocations` or
      `config_evals` reddens; removing `entry_inputs` or
      `output_files` does NOT, because they cascade off `entries` like
      `output_dirs`. Four of the list's members are load-bearing and
      three are already covered by the cascade.
      Pinned with the law rather than the list: plant a row in EVERY
      table the schema creates, force the reset, and assert the exact
      surviving set is `['config_closures', 'schema_meta']`. A table
      added later and forgotten reddens it unless it cascades — which
      is the only case where forgetting it is harmless anyway.
      Method note, and it is 488's trap sprung on me again: the first
      probe reported that NOTHING survived, because it planted
      `created_at = 1` and the config TTL sweep deletes anything that
      old. The payload has to be one the code would really see. Re-run
      with a recent timestamp, `config_closures` appeared — the whole
      finding was hiding behind a placeholder value.

505.  DONE (2026-09-20, the KEY FOLD in `cache.ts` and the config
      projection in `task-hash.ts` — a wrong key is this project's
      worst failure class, and the fold is a LIST, so it was swept as
      one).
      The value parts are pinned: dropping the taskId, the workspace
      fingerprint, the project package.json hash or the config hash
      fails 1, 1, 3 and 7 rows. `exec.remote`'s stripping fails 2.
      THE SURVIVORS are the list COUNT prefixes — `env-values:N`,
      `upstream:N`, `forward-args:N` — and the classification took two
      experiments rather than one.
      Individually they are redundant for DISCRIMINATION. Remove any
      single one and re-key 4,000 randomized inputs: the same 1,210
      distinct keys, zero collisions. The neighbouring labels still
      frame the sections and the fold is seed-chained, so order
      already carries the information.
      Jointly they are not redundant at all. Remove TWO ADJACENT
      prefixes and the same 4,000 inputs collide 31 times, with
      witnesses of exactly the predicted shape: one pair moved from
      `envValues` to `runtimeValues`, or an extra pair shifted across
      the boundary. Two different input sets, one key — the stale hit
      the key exists to prevent.
      So the pin is the GUARANTEE, not a member: three rows asserting
      that moving a pair across a section boundary moves the key, each
      with a control that the same input twice gives the same key. A
      SINGLE removed prefix leaves them green, which is right — that
      removal really is harmless; the double removal reddens two of
      the three, each at its own boundary.
      Also classified: `hashableConfig`'s early return. Measured, the
      spread path produces byte-identical JSON for every config that
      HAS an `exec`, so the fast path is a shortcut, not the reason
      the field needed no CACHE_VERSION bump. Its one behavioural case
      is a config with no `exec` — and a reachability probe (throw on
      a no-exec config, whole suite) never fired, because group tasks
      take `computeGroupHash` instead. De-claimed accordingly.
      Method note: this is rule 4 — several guards, one guarantee — in
      its purest form yet, and the lesson is about what to ASSERT. A
      row per member would have been wrong twice over: it would pass
      on the removal that matters (the other member still frames the
      section) and fail on the removal that does not. The guarantee is
      the only thing with a single truth value, so the guarantee is
      what the row says.

506.  DONE (2026-09-20, `orchestrator/admission.ts` — dedup and
      continue-taint, both silent when wrong: a missed taint SAVES
      what a task built on partial upstream output, under a key a
      healthy run derives).
      A HELD report, and the taint half is the best-pinned predicate
      swept yet. All five members have their own row —
      `failed` (2), `aborted`, `skipped`, the transitive
      `tainted.has(...)`, and the RECORDING step that makes it
      transitive. `taint-tracker.test.ts` already does what 494, 497
      and 499 had to add elsewhere.
      Dedup: the restore-tier bypass, the deferred barrier lift (it
      lifts when the ENTRY lands, not when the task returns) and the
      joiner's wait each redden. `!cacheable` survives, and it is an
      early-out rather than a guard: measured, a non-cacheable task
      never finds a sibling barrier, because the hash folds the taskId
      and a taskId executes once per run. Removing it reddens nothing
      AND a throw on "a non-cacheable task joined a barrier" never
      fires across the whole suite. Recorded in place.
      Method note, and it cost a round: the first dedup pre-check ran
      `bun test tests/dedup.test.ts tests/upstream.test.ts` and all
      four mutations "survived". There is no `dedup.test.ts` — bun
      silently ignores a nonexistent path, so only the 17 unrelated
      rows ran. The real file is `inflight.test.ts`, where three of
      the four redden immediately.
      This repo already knows that rule and I walked into it anyway,
      so the fix is procedural rather than another note: every
      mutation batch now ends with a PRISTINE control run in the same
      command. `4 pass 0 fail` next to the mutants' `3 pass 1 fail`
      is what distinguishes "the tests ran and passed" from "no tests
      ran at all" — the same ambiguity 499's unparseable payload
      created, reached by a different road.

507.  DONE (2026-09-20, `orchestrator/placement.ts`'s
      `pinnedLocalSet` — which tasks may NEVER leave this machine. A
      wrong answer runs a sandboxed task remotely, where the sandbox
      is the only thing proving what it touches).
      A HELD report. Four of five members have their own rows:
      `exec.persistent` (1), `exec.sandbox` (2), `exec.remote: false`
      (1) and the TRANSITIVE clause — a task whose dep is pinned is
      pinned — which fails 3.
      The fifth, the pre-recursion `memo.set(id, false)`, survives and
      is DEFENSIVE by its own comment: it guards a cycle the graph
      builder already rejects, and the memo proper (`memo.set(id,
result)` after) keeps working without it. Its failure mode is
      also LOUD — unbounded recursion, not a wrong placement — so it
      is the rare survivor that needs neither a row nor a de-claim.
      Recorded because a sweep that reports only holes is one whose
      negative results nobody can read, and because this is the second
      file in a row (with `admission.ts`) whose predicates were
      already pinned member by member. The practice this sweep has
      been retrofitting is present in the newer files; what it keeps
      finding is older code written before the habit.
      Also confirmed the new batch rule works: every run in this
      sweep ended with a PRISTINE control (`5 pass 0 fail`) beside the
      mutants, so `no-memo`'s `5 pass 0 fail` means the rows ran and
      passed rather than that nothing ran.

508.  DONE (2026-09-20, `orchestrator/miss-save.ts`'s empty-artifact
      warning — the one symptom a sandboxed task with no write grant
      shows, per item 444: its writes land in the sandbox's scratch,
      the shell sees success, and the run is green over a build that
      produced nothing).
      HELD, and completely: both halves of the condition (outputs
      DECLARED, and nothing RESOLVED) fail rows in
      `cache-declaration-warnings.test.ts`, and both halves of the
      sandbox HINT — "is it sandboxed" and "does it grant a write" —
      fail a row named exactly for the job: "a sandboxed task that
      produced nothing says why > names the missing write grant,
      because nothing else would".
      Worth recording HOW that was found, because the per-file
      pre-check said the hint clauses survived. They live in the
      `.unsafe` suite, which the pre-check did not run. That is item
      500's rule doing its job on the first try after being written
      down: the pre-check can only ever say "not here", and the
      whole-suite verdict is what says "nowhere".
      THE SATURATION SIGNAL, which is the real result of 506-508:
      three held reports in a row, on `admission.ts`, `placement.ts`
      and `miss-save.ts`. Each was already pinned member by member —
      the practice this sweep spent fifteen items retrofitting is
      standard in code touched recently. What 493-505 kept finding
      was OLDER code: a priority closure from the first scheduler, a
      classifier duplicated four ways, an alphabet nobody re-read, a
      boundary asserted on one side. So the next sweep should select
      by AGE and by last-touched date, not by cost alone — cost says
      where a defect would hurt, age says where one is still likely
      to be.

509.  DONE (2026-09-20, `orchestrator/run-context.ts` — the FIRST item
      selected by 508's age rule, and it paid on the first try after
      three held reports).
      The selector needed a substitute: this checkout's per-file git
      history is unusable (every source file reports ONE commit), so
      age came from the newest DATED COMMENT in each file, which this
      repo writes everywhere. `run-context.ts` tops that list at
      2026-07-14, six weeks older than anything else.
      Two real gaps, both the shapes this sweep keeps finding.
      THE CASE FOLD. `isTruthy` rejects undefined, `''`, `'0'` and
      `'false'`, lower-casing before that last compare. The `''` and
      `'0'` members each fail a row; the FOLD fails nothing. So
      `CI=False` — what a PowerShell `$false` and several CI templates
      write — is reported as running in CI, in the invocation header
      every run carries. 494's alphabet again: the fixture spelled it
      one way. Pinned with a row per spelling (`false`, `False`,
      `FALSE`, `fAlSe`) plus a control that an unrecognised value is
      still CI, so the rows cannot pass on a predicate that calls
      everything falsy. Three rows redden.
      THE SCP GATE. `normalizeRemoteUrl` strips `:NNNN` only when the
      URL HAD a protocol, because the scp shorthand `host:path` has no
      port and its first segment may be numeric. The strip fails a
      row; the GATE fails nothing — so `git@host:2222/o/r`, where 2222
      is a directory, silently lost it and collided with any other
      repo at `host/o/r`, giving two repositories one workspace id.
      Pinned on BOTH sides (503's rule): the protocol form strips,
      the scp form keeps, and a control that the ordinary spellings
      still agree.
      Method note: the age rule's first outing produced two finds
      where cost-ranking had just produced three held reports in a
      row. That is one data point, not a law — but the mechanism is
      plausible enough to keep: a file nobody has touched in six weeks
      has had six fewer weeks of someone reading it while fixing
      something adjacent.

510.  DONE (2026-09-20, `cli/last.ts` — second by the age rule, newest
      dated comment 2026-08-23. `vx last` exists to REPORT a run
      accurately, so its formatting boundaries ARE its contract).
      Five survivors, all together passing the whole suite in one
      combined run: `<` → `<=` at BOTH duration cuts (1 s and 60 s),
      the divide-by-zero guard on the cpu ratio, the violation count's
      `> 0`, and its singular/plural.
      Pinned: a row per duration boundary asserting AT the cut (999 →
      `999ms`, 1000 → `1.00s`, 59 999 → `60.00s`, 60 000 → `1m 0s`), a
      row that a zero-duration task reports no ratio rather than
      `NaN× cpu` (a replay showing NaN is a report that lies about the
      run), and a table over 0/1/2 violations with a control that the
      rest of the row survives.
      THE MISTAKE, and it is the sharper half: the violation row as
      first written used `toContain('1 sandbox violation')` — and
      `'1 sandbox violations'` CONTAINS that string, so the plural
      mutation passed my own new row. Four of five differentials red,
      one green, which is the only reason it was caught. Rewritten to
      assert the row's SUFFIX exactly; now all five redden.
      That is this repo's own rule ("assert the exact expected set,
      not the absence of one string") and the `grep -q ok` matching
      "broken" lesson, met from the assertion side. A containment
      check on a string whose wrong version is a SUPERSTRING of the
      right one cannot fail. When the difference between correct and
      incorrect is a suffix, the assertion has to be an equality.

511.  DONE (2026-09-20, `cache/tar-stream.ts` — third by the age rule,
      newest dated comment 2026-09-03. `orchestrator/options.ts` ranked
      between it and `cli/last.ts` and was SKIPPED as types-only: the
      age ranking needs that refinement, a file with no executable
      logic has no boundary to move).
      Eight boundary mutations over the reader's and writer's cuts.
      Three were already caught (the 100-byte tail, the 155-byte
      prefix, the all-octal check). Five survived the whole suite;
      four are now pinned and the fifth is measured-equivalent.
      Baseline note: outside a sandbox this container's
      `Bun.Archive#files()` answers `[]`, so the multibyte pax row is a
      standing one-fail baseline here and "caught" means two or more.
      THE PAX CUT. `needsPax` keys on the 100-byte name field, and the
      four names in the ustar-limits row all carry a `/` — so they
      exercise the PREFIX split, and the name field's own cut had no
      witness at all. Narrowing it to `> 101` does not corrupt: a
      101-byte slashless name throws `name too long for ustar` at pack
      time. Pinned with the block count as the witness (100 bytes is
      header + body, 101 is a pax header and its record ahead of them),
      read back through vx and libarchive.
      THE ZERO-LENGTH PAX RECORD. `len <= 0` → `len < 0`: the cursor
      advance IS the length just read, so a `0 path=…` record never
      moves it and the reader spins. The existing row covered a length
      that overshoots the body and one that undershoots it — never one
      that is zero, which is the only value that turns a wrong answer
      into NO answer. Pristine throws `malformed pax` in under 2 ms.
      Recorded honestly: this row's differential is a HANG, not a red
      row — a tight loop never yields to bun's per-test timer, so the
      mutant is caught as a job timeout rather than a `(fail)` line.
      THE NUL-FILLED FIELD. `octal` answers 0 for an empty field BEFORE
      the all-digits check. Drop that and a header whose mtime is
      NUL-filled rather than zero-padded — what producers older than
      ustar write — is refused outright with `bad octal field: ""`.
      Pinned on `mtimeMs`.
      THE CHECKSUM'S OWN BYTES. `checksumOk` substitutes a space for
      all EIGHT bytes of the field, 148..155. Narrowing it to 155 is
      equivalent for every producer that ends the field `<NUL><space>`
      (vx's own writer sets `h[155] = 32` itself, so its archives can
      never tell) — and rejects the `<space><NUL>` ordering POSIX
      allows just as much. Found by measuring the OTHER ordering, not
      by reading the mutation: the mutant looked equivalent right up to
      the input that discriminates it. Pinned on both orderings.
      THE EQUIVALENT ONE. `tail >= 1` → `tail >= 0` in `splitForUstar`
      moves where a name ENDING in `/` splits: the whole path into the
      prefix and an EMPTY name field. Both encodings read back to the
      same entry name (the reader strips trailing slashes) and
      libarchive lists neither, and `tarPack`'s only callers pack
      output FILES. No reachable input discriminates it, so it is
      classified, not pinned: a row would assert byte placement for an
      input vx cannot produce.
      Method note, and it sharpens 498's rule. Three of the four pins
      came from measuring what the mutant does to an input the suite
      NEVER HAD — a slashless long name, a NUL-filled field, the other
      checksum ordering — not from what the mutation's text looks like
      it does. Classify a survivor by what breaks when it goes, yes;
      but read that forward too. A survivor names a MISSING FIXTURE,
      and the missing fixture is usually another spelling of an input
      the suite already has (494's alphabet, 509's case fold, this
      file's four long names that all happened to carry a slash).

512.  DONE (2026-09-21, `workspace/migrate-scripts.ts` — fourth by the
      age rule, newest dated comment 2026-09-04. This is the mapper
      `vx init` IS, so a wrong answer here is a silently wrong
      ADOPTION, not a wrong report: the user reads the generated
      config once and trusts it thereafter).
      The widest sweep yet: 50 mutations over its whole decision
      surface — `AFTER_BUILD` member by member, every `LIFECYCLE`
      alternative, `delegatedScript`'s package-manager forms and each
      excluded shell metacharacter, the group branch's four conjuncts,
      `scriptsOf`'s three guards, the names filter, the hook order.
      21 caught. 29 survived `init.test.ts` AND the whole suite —
      every one confirmed at full scope, with a pristine control
      identical to the baseline. Six rows now catch all 29.
      TWO CRASHES, and they are the sharpest of the set. `package.json`
      is a boundary, and both guards there had no witness: with the
      null check gone, `"scripts": null` is `TypeError: null is not an
object` out of `vx init` (`typeof null === 'object'`, so the
      object test alone lets it through); with the string check gone,
      `"scripts": { "a": 123 }` is `TypeError: command.trim is not a
function`. A stack reaching the user where a declined package
      belongs is the same defect class as `isFsRefusal`.
      THE ALPHABET, twice. `AFTER_BUILD` has four members and only
      `test` had a witness — though the delegate fixture already
      declares a `typecheck` and a `check` beside a `build`. A
      `typecheck` that does not wait for `build` is exactly what breaks
      on project references. And of the eleven npm LIFECYCLE names only
      `install` and `pack` were witnessed: drop `publish`, `version`,
      `prepare` or `prepublishOnly` and each becomes a vx task nobody
      asked for — `prepare: husky install` scheduled as build work.
      Pinned as the guarantee rather than per member (505): the exact
      set of names that wait for `build`, and the exact set of tasks a
      package declaring every lifecycle script generates.
      THREE WAYS THE GROUP BRANCH GOES WRONG, all unwitnessed. Drop
      `has(delegate)` and `npm run nosuch` becomes a group over a task
      nothing defines; drop `delegate !== name` and `loop: npm run
loop` becomes a SELF-CYCLE; drop `hooks.length === 0` and a
      delegating script's folded `pre` hook is dropped on the floor,
      because a group has no command to hold it. One row, three cases,
      and a CONTROL on its own fixture (496) that a delegation with
      none of those problems is still a group.
      AND AN EDGE TO A BUILD THAT IS NOT THERE. Both the command path
      and the group path gate their `build` edge on `hasBuild`, and
      neither gate had a witness: without them a package with a `test`
      and no `build` generates `dependsOn: ['build']`. The group path
      also de-duplicates when the delegate IS `build` — also
      unwitnessed, `['build', 'build']`. Pinned by asserting the exact
      EDGE SET, which is one assertion for all three.
      THE ELEVEN WITH NO CONFIG-LEVEL WITNESS, recorded as such.
      Removing any one metacharacter from `delegatedScript`'s excluded
      class changes what the exported function RETURNS, but not one
      generated config — `has(delegate)` rejects the mangled name
      before it can become a group. So they are pinned at the function,
      where the contract is ("flags, arguments or a chain make it a
      real command again"), and the write-up says so rather than
      claiming a config that never differs.
      Method note: the per-file pre-check over `init.test.ts` and the
      whole-suite verdict agreed on all 29 this time — the first sweep
      where 500's gap did not open. That is not a licence to skip the
      verdict; it is one file with one obvious test, and the cheap
      check was right because the mapper has exactly one caller.
      Yardstick note: four of the 29 verdicts showed a watch-loop row
      DROPPING OUT of the baseline and one showed `vx watch loop (e2e)

      > a first sighting is a change only when its mtime falls after
      > the arm`appearing, which is not on the flapper list. Five runs
of`watch-loop.test.ts`alone were clean — isolation is the wrong
environment, since these rows flap under the loaded sandboxed
run. The exact repeat of that one verdict did NOT reproduce it
(its only new row was the new`delegatedScript`one, catching the
mutation as designed), so it is a fourth flapper, not a catch.
NOT added to`base.names`: a yardstick entry swallows a real
failure, and the same rule that keeps `shard-9` out keeps this
      > out. A yardstick that moves in BOTH directions is the thing to
      > watch — the list names three and the watch family clearly has
      > more.
