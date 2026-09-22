# Shipped, 2026-09 — improvement-loop items 513–532

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
`2026-09-improvement-loop-473-492.md`, items 493–512 in
`2026-09-improvement-loop-493-512.md`; items 533 onward continue in
`docs/STATUS.md`.

513.  DONE (2026-09-21, `cli/help.ts` — fifth by the age rule, newest
      dated comment 2026-09-04. The help text is where a user goes
      when they are already lost, so a cut that shows another verb's
      flags is worse than no cut at all).
      20 mutations over the two functions that CUT the reference:
      `verbHelpText`'s per-verb slicer and `documentedFlags`' section
      scanner. Nine caught; eleven survived their own files. One of
      those eleven was caught by the WHOLE SUITE (below); four were
      real and are fixed or pinned; six are equivalents.
      A DEFECT FOUND BEFORE THE SWEEP, by probing the function
      directly. `verbHelpText` interpolates the verb into a `RegExp`
      unescaped, so `r.n`, `(run)` and `[rn]un` each matched the
      `vx run` Usage line and answered with a help cut for a verb that
      does not exist, and `.*` returned 88 of the reference's 138
      lines — while the function's own comment promises "a verb the
      reference does not know gets the whole thing". A comment
      claiming a guarantee the code lacks is a defect, and here
      IMPLEMENTING it is one line (escape the verb) against
      de-claiming it, so the escape went in. Scope stated honestly:
      both callers gate on `CORE_VERBS.includes`, an exact-membership
      test, so nothing reachable through the CLI hit it today — it was
      a trap set for the third caller.
      THE MISSING ANCHOR. Drop the `^` from that same pattern and
      `vx lock --help` grows by 26 lines: the ENTIRE `Execution (for
run)` block, because the `--frozen` line happens to say "pair
      with `vx lock --check`" mid-line. The existing row checks `run`,
      `cache` and `last` with `toContain` — 494's alphabet again, and
      `lock` is the member whose cut the cross-reference poisons.
      Pinned as the exact flag SET of three cuts, which is also 510's
      rule: a `not.toContain` passes while any single flag leaks.
      THE EM-DASH ACCIDENT. `documentedFlags` treats a line as a
      section header via `/^[A-Z][A-Za-z ]*(?: \(for [a-z]+\))?:$/`.
      Widen that character class by one character and `--dry` and
      `--graph` silently LEAVE run's documented flags — because
      `Planning (for run — skips execution):` carries an em dash, fails
      the header test, and so leaves the scanner inside the previous
      `(for run)` section. Those two flags are in the list by accident
      of punctuation, and the list is what `vx run --dryy` suggests
      from. Pinned as the exact sorted set of all 24.
      THE EMPTY SECTION. `pluginCommands.length > 0` had no witness:
      without it every `vx help` with no plugins prints a bare
      `Plugin commands:` heading with nothing under it. Pinned with a
      control that the section DOES appear when the list is not empty
      (497), so the absence claim is about the gate.
      500's RULE EARNS ITS KEEP AGAIN. `printHelp`'s
      `verb === undefined` branch survived `cli.test.ts` and
      `completions.test.ts` together — and the whole suite caught it in
      `plugin commands > vx help lists plugin verbs with their
description and plugin`, a third file. I had already written
      "`vx help` is entirely unasserted" in my head; the verdict said
      otherwise. The cheap check says "not here" and nothing more.
      THE SIX EQUIVALENTS, measured not assumed: the word boundary
      after the verb, `startsWith('Usage')` for `=== 'Usage:'`,
      scanning the title block, `^[A-Za-z]` for `^[A-Z]`, dropping the
      header pattern's end anchor, and `includes` for `endsWith` on
      `(for <verb>):`. Each produces BYTE-IDENTICAL output for all
      thirteen core verbs and is clean at whole-suite scope. They guard
      against text this reference does not contain yet — a verb that
      prefixes another, a block headed `Usage` without the colon — so a
      row would assert today's wording, not a guarantee.
      HARNESS NOTE, and it cost a full differential. The fix changed
      the very line the mutation driver rewrites, so every mutation
      generated from the OLD pristine silently reverted the escape too
      — and the regex row reddened under all five, which reads exactly
      like "they are all caught". Re-pointed the driver at the FIXED
      source and re-ran; one payload (`nm-boundary`) did not contain
      the replaced substring and had to be fixed by hand. When a fix
      and a sweep touch the same lines, the sweep's baseline is the
      FIXED file, and a differential where everything reddens is a
      confound, not a result.
      Flapper note: `df-noparen`, whose output is provably identical,
      showed a watch e2e row appearing in its whole-suite verdict.
      That is the fifth watch-row flap across two sweeps, and here the
      identical output rules out cause without needing a re-run.

514.  DONE (2026-09-21, `exec/sandbox-violations.ts` — sixth by the age
      rule, newest dated comment 2026-09-05. The richest file yet, and
      the one where a wrong answer is quietest: a violation this drops
      is a sandboxed task that TRIPPED reporting CLEAN, and since the
      key folds a project's declared inputs, an undeclared read is
      exactly what makes a cached artifact wrong later. The file's own
      header already records one such incident — a single-line strace
      regex silently dropped every interleaved syscall).
      31 mutations. 17 caught; 14 survived the file's own suite AND the
      whole suite, each confirmed against a pristine control. Eight new
      rows catch 13; the fourteenth is classified.
      THE END ANCHOR, and it is the sharpest thing this sweep has
      found. `loopbackNoise` drops `deny(1) network-outbound` with
      `\s*$` on the end, because the addressless record is noise no
      grant can silence. Remove that one anchor and it also drops
      `deny(1) network-outbound example.com:443` — a connection that
      tried to LEAVE THE MACHINE, reported by SRT's proxy WITH its host
      and port. The function's comment states that exact guarantee
      ("a line this keeps") and nothing asserted it. Pinned under BOTH
      grants that turn the filter on.
      THE PROJECT BOUNDARY, twice. The deny anchor is
      `abs === root || abs.startsWith(root + path.sep)`, and neither
      half had a witness: drop the equality and a denial on the project
      root itself vanishes; drop the separator and a SIBLING directory
      (`/ws` matching `/wsother`) is reported as inside the project.
      The same pair again in `withinReported`, where `within: '/'`
      without its separator special-case drops every record there is —
      a case that function's own comment calls out.
      THE ALPHABETS. `openat|access|statx|newfstatat` and
      `ENOENT|EACCES|EPERM`, the second in two different line shapes.
      `newfstatat` and a completed-line `EPERM` each had no witness, so
      every denial of that syscall or that errno was a line the report
      would never mention. Pinned member by member in both shapes.
      THREE MORE, all silent. The dedup key is `(syscall, path)`; key
      it on the path alone and two different calls on one file collapse
      to one, losing a denial. An `openat` is marked ignorable by BOTH
      the read and the write list, because the trace does not carry the
      flags that would say which — drop either and that grant stops
      working. And the seatbelt target is captured LAZILY, so a line
      with trailing spaces yields a clean target; make it greedy and no
      `ignore` entry for the real path matches again.
      THE GLOB THAT IS A FILENAME. `matchesIgnore` compares a pattern
      exactly BEFORE globbing it. `a[1].txt` is a real filename whose
      `[1]`, read as a glob, is a character class that does not match
      it — so the exact compare is what lets an `ignore` entry copied
      out of a real tree work at all. Pinned with a control on its own
      pattern that the glob branch still globs, so the row cannot pass
      on a matcher that lost globbing instead.
      THE ONE LEFT CLASSIFIED. `matchesIgnore`'s `v.target === undefined`
      guard: `reportableViolations` fills `target` from the line before
      any filter runs, so "ignorable set, target undefined" is a state
      neither producer reaches. My first row for it asserted a
      targetless record is kept — and could not fail under ANY of the
      31 mutations, because the record it used parses into a target.
      Cut rather than contorted into forcing a crash on an unreachable
      state; a guard against the unreachable is worth keeping in the
      code and not worth a row.
      THREE FIXTURE MISTAKES, and they are the lesson. The network
      grant lives under `allow.network`; my first fixture put it at the
      top level, so `resolveSandboxConfig` stored nothing, the filter
      never turned on, and the arm "proved" the loopback record was
      kept — a green reading of a switch that was off. My first probe
      never called `parseStraceViolations` at all, so EIGHT survivors
      came back "no observable difference" when the truth was that I
      had not run the function they live in. And the targetless
      assertion above could not fail. Every one is the same error in a
      different coat: the fixture did not exercise the thing. 511 said
      a survivor names the missing fixture; 514 adds the other half —
      before believing "no difference", prove the probe reaches the
      mutated line.
      Flapper note: two of the fourteen verdicts showed a watch e2e row
      appearing, both on mutations confined to violation filtering.
      That is the sixth and seventh instance across four sweeps, the
      pristine control was clean every time, and the list still names
      three. Still not added: a yardstick entry swallows a real failure.

515.  DONE (2026-09-21, `orchestrator/framed-output.ts` — seventh by the
      age rule, newest dated comment 2026-09-05. A report file, like
      `cli/last.ts` in 510: every finding here is the run's own output
      lying about what happened).
      23 mutations over the row grid, the cells, the violation section
      and the frame close. Seven caught by the file's own suites; 16
      survived the per-file pre-check. Five new rows now catch 14 of
      those 16 locally.
      THE PRE-CHECK OVERSTATED THE GAP BY FIVE, and that is this item's
      first lesson. Of the 16 survivors, the whole-suite verdicts found
      witnesses for FIVE that the three-file pre-check never ran: the
      failed and skipped GLYPHS are held by `the documented glyph set
is the set the renderer prints`, a doc-drift row; `no-cache` vs
      `miss` is held by five rows, one of them named almost exactly for
      it (`a task without a cache block is no-cache, never miss — row
words, legend and report column all agree`); the blank time cell
      by five more; the skipped row's blocker suffix by three. I had
      already written those up as gaps. 500's rule is not only "a
      per-file check cannot say nowhere" — it is that the check will
      HAPPILY SAY SOMETHING, and what it says is worth nothing until
      the suite agrees.
      THE REAL GAP WAS TEN, and the headline is the plainest failure a
      report can have: `statusOf` losing its `failed` case makes a
      FAILED task's row read `success`, and nothing in the repo
      noticed. Verdicted twice at whole-suite scope — the first run's
      only new row was the watch-loop flapper, the repeat had none at
      all. Its siblings: a skipped outcome down the SHARED row path
      reads `success` too, a failed task's cache cell goes blank, and
      the remote fresh/restored pair inverts in both the word and the
      glyph.
      THE CRASH. The time cell pads with `' '.repeat(TIME_COL -
raw.length)`, clamped at 0. Without the clamp a task running past
      about 2.8 hours produces a duration string wider than the column,
      the count goes negative, and `repeat` throws a RangeError — a
      run that SUCCEEDED taken down by its own report. Pinned with a
      99 999 999 ms row that renders `100000.00s`.
      TWO MORE. A `sandboxViolationLines: []` — what every clean
      sandboxed task carries — printed a `SANDBOX VIOLATIONS (0)`
      heading over nothing when the guard keys on the field's presence
      alone. And a persistent task that FAILED closed its frame as
      `running`, which reports a dev server that is up when it is down;
      the existing row covered only the success close that `running`
      is actually for.
      PINNED AS ONE GRID, not nine rows (505). The status word, the
      cache word and the glyph are three axes of one table, and every
      single-member mutation moves exactly one line of it — so the
      assertion is the whole 9-line table. That one row catches eight
      of the sixteen.
      THE EQUIVALENT. `cell`'s `Math.max(0, width - text.length)`:
      every status and cache word is a fixed literal no wider than its
      column, so nothing reachable overflows it. Classified — unlike
      the time cell, whose input is a duration and therefore unbounded.
      Fixture note, the third item running. Two pairs looked equivalent
      for reasons that had nothing to do with the mutations:
      `formatTaskSkippedLine` hardcodes its own glyph and word, so a
      skipped outcome only reaches `glyphShape`/`statusOf` through the
      SHARED row path my probe was not using; and the first colour
      probe passed `NO_COLOR`, which makes `paint` a no-op and hides
      both styling mutations completely. Same shape as 514's three.
      Flapper note: the watch row `a first sighting is a change only
when its mtime falls after the arm` appeared again and did not
      reproduce on the repeat — the ninth instance across five sweeps.
      Still three on the list, still not added.

516.  DONE (2026-09-21, `exec/local-executor.ts` — eighth by the age
      rule, newest dated comment 2026-09-05, and 41 lines. Core's
      FLOOR: the executor that runs a task when no plugin claims it, so
      a field it drops is a feature that stops working with no plugin
      in sight and nothing to point at).
      The file is almost entirely field FORWARDING, which changes what
      a sweep of it means — most single-field mutations are rejected by
      the TYPE CHECKER, not by any test. So this sweep ran
      `lint.oxlint` (type-aware) AND the tests for each of 18
      mutations, and counted the two separately:
      8 caught by a test, 7 caught by TYPES ONLY, 3 by neither.
      Keeping those middle seven apart matters both ways. Calling them
      survivors would have claimed a gap the type checker already
      closes; calling them tested would have been false. They are the
      sandbox forwards and the two conditional spreads, where
      `exactOptionalPropertyTypes` makes `liveChildren: undefined` an
      error on its own.
      AND THE SCARIEST OF THE THREE WAS ALREADY COVERED. `liveChildren`
      is the set the orchestrator's SIGINT/SIGTERM handler kills, so
      not forwarding it leaves a child alive past Ctrl+C — the
      orphaned-process class this repo keeps a helper for. I wrote it
      up as the headline gap. The whole-suite verdict came back with
      TEN failing rows: the signal e2e family (SIGINT/SIGTERM/SIGHUP
      exits, grandchild reaping, SIGKILL after the grace) covers it
      thoroughly. 500's rule again, and a sharper form of it — I had
      ranked the three findings by how alarming each sounded, and the
      alarming one was the tested one. Rank by what the VERDICT says,
      never by the size of the consequence.
      THE REAL GAP WAS TWO, both quiet. `onStderr` unforwarded means a
      task's stderr never reaches the reporter — output vanishing with
      the task still passing. `capture` unforwarded means a caller that
      asked to retain NEITHER stream gets both, since the runner's
      default is to keep them. Neither is a crash, neither fails a
      task, and nothing exercised either.
      Pinned as one row over all three forwards (the third is now
      doubly held, which costs nothing): the kill-set registration via
      a Set subclass that counts its own `add` calls — deterministic,
      no sleep, no timing claim — plus the two callbacks and a
      `capture: { stdout: false, stderr: false }` result.
      Housekeeping note: the sweep wrote `m`, `out.txt` and `tries.txt`
      into the REPO ROOT. The `drop-cwd` mutation makes a task run in
      the process's cwd instead of its own, and `executor.test.ts`'s
      fixture builds its request with `cwd: process.cwd()`. Untracked,
      confirmed not in git, removed. A sweep that mutates a path can
      write outside its sandbox: check `git status` for UNTRACKED files
      after one, not only for modified ones.

517.  DONE (2026-09-21, `cache/file-hashes.ts` — ninth by the age rule,
      newest dated comment 2026-09-09, and chosen over its band-mates
      because a wrong answer here is a STALE HIT: the per-file memo
      decides what a file contributes to every cache key).
      A REAL DEFECT, FIXED. `hashFile` lstat's, and folds a symlink as
      git folds it — the blob of its LINK TEXT, which is its
      mode-120000 index OID. `hashFiles`, the batch form, stat'ed:
      it FOLLOWED the link and hashed the TARGET'S BYTES. So the same
      path had two identities depending on which entry point a caller
      used, and the batch folded bytes `git diff` and `--affected`
      cannot see — precisely what `hashFile`'s own rationale says must
      never happen. A link to a directory and a dangling link were
      worse still: absent from the batch entirely, present and hashed
      from the per-file form.
      It is reachable, not theoretical. `project-loader` keys a config
      closure from the BATCH on its fast path and from `hashFile` on
      its slow path, so the two paths identified the same closure
      differently. And the batch's own docblock said "Same stat fields,
      same racy-clean rule, SAME DIGEST" — a comment promising what the
      code did not do, which this repo calls a defect. Implemented
      rather than de-claimed: the batch now lstat's and folds a symlink
      the same way, with no memo row (the row would key on the link's
      own stat, not its target's). No `CACHE_VERSION` bump: a
      key-derivation fix whose old key was already wrong is
      self-healing.
      THE PRE-FIX STATE PASSED THE WHOLE SUITE. Verdicted: `NEW=[]`.
      Nothing anywhere caught it.
      THE SECOND COPY IS WHERE A RULE DRIFTS, and that is this item's
      lesson. The four memo fields are compared in TWO places —
      `hashFile` and `hashFiles` — and the racy-clean rule twice more.
      I swept both copies and wrote up "ctime has no witness". The
      verdict corrected me: `one-ctime` is caught by an existing row
      named almost for it (`stale cache hits > a content change that
preserves mtime is not served from the file-hash memo`). The
      PER-FILE copy is well guarded. Only `many-ctime` survives. Same
      root cause as the symlink bug: `hashFiles` arrived later as a
      batch optimisation and inherited neither the behaviour nor the
      test of the rule it duplicated. When a rule has two copies, sweep
      both — and expect the newer one to be the bare one.
      THE STALE HIT ITSELF, now pinned through BOTH forms. Rewrite a
      file with the SAME byte length and restore its mtime — what
      `tar -x`, `unzip`, `cp -p`, `rsync --times` and any
      SOURCE_DATE_EPOCH generator do. Size, mtime and inode all match;
      only ctime differs. The row asserts those three still match
      before asserting the digest changed, so it cannot pass on some
      other field doing the work.
      TWO MORE, both unwitnessed in both copies. A READ-ONLY store
      (`write: false`, "a miss is hashed but not remembered") was
      writing memo rows. And without `Math.floor` a fractional
      millisecond lands in an INTEGER column — SQLite's loose typing
      takes it silently, and two builds that floor differently stop
      agreeing.
      CLASSIFIED, NOT PINNED: `mtime`, `size` and `ino`, in both
      copies. Every write bumps ctime, so none of the three can
      independently produce a stale hit on this filesystem — measured
      by construction, not assumed. `ino` would matter where ctime
      granularity is coarse (git keys on ctime+ino+dev for that
      reason), which this box cannot build. Also `chunk` (500 → 1),
      which is throughput only.
      And a control mistake of my own: the read-only row failed first
      run because I pointed the read-only `Cache` at the SAME cache dir
      as the suite's, so it counted rows the write-enabled store had
      just written. 496's rule — a control must not share state with
      what it controls — broken by me, caught by the row.
      A NEW FLAPPER, recorded not adopted. This item's gate failed one
      row outside the known set: `vx why (e2e) — answers from the
database alone > a project config that throws changes nothing it
prints`, in shard-3. It is the test's own CONTROL — it sabotages
      a config to throw `PROJECT CONFIG EVALUATED` and checks that
      `vx run`, which does evaluate configs, trips on it. Evidence it
      is not this diff: six isolated runs of `why.test.ts` were clean
      on BOTH the fixed and the pre-fix source, and shard-3 passed on
      re-run with vx recording the task flaky on identical inputs. The
      signature is worth keeping for next time — the error surfaced
      WITH its stack and WITHOUT its message (`vx: Error` then the
      frames), so the message, not the reporting, is what went missing.
      Mechanism unknown; not added to `base.names`, because a yardstick
      entry swallows a real failure.

518.  DONE (2026-09-21, `workspace/config-cache.ts` — tenth by the age
      rule, newest dated comment 2026-09-09. The purity deny-list
      decides which configs get their evaluation CACHED AND REPLAYED,
      and the module states its own stakes: the check fails SAFE, never
      fast, because "a false negative costs one evaluation, a false
      positive would cost a STALE KEY").
      25 mutations: one per `IMPURE_RE` member, plus its three guards.
      Ten survived the file's own suites. Each one is that false
      positive made real — drop the member and a config reaching the
      environment through it is CACHED AS PURE, measured, not argued.
      THE LIST WAS NOT NEGLECTED, IT GREW. Thirteen members have their
      own named row, including every one the file's comment records as
      a past bug (`globalThis`, `global`, `self`, `Temporal`,
      `constructor`, `localeCompare`). The gap is the newer entries,
      which arrived without fixtures. Say it that way: this is drift at
      the edge of a maintained list, not an unguarded one.
      A DOC-DRIFT ROW IS NOT A BEHAVIOURAL WITNESS, and that is the
      finding worth keeping. Of the ten, FIVE (`performance`,
      `navigator`, `eval`, `await`, `toLocale*`) are caught at
      whole-suite scope only by `a module page quotes a constant or a
regex the module has > config-cache.md's impurity list is
IMPURE_RE's`. That row notices a member being DELETED, because
      the docs list it — it does not exercise the member at all, and
      would not notice one that is present and broken. The other FIVE
      (`Intl`, `crypto`, `Function`, dynamic `import(`, and the
      stripper's `null` guard) are caught by nothing whatsoever.
      TWO MEMBERS HIDING BEHIND EACH OTHER. The existing row named
      `refuses to cache a config that mentions await import('./x.mjs')`
      catches NEITHER `await` NOR dynamic `import(` when either is
      dropped: its one snippet contains both, so each masks the other
      and the row passes on the survivor. A fixture that names two
      members holds neither. This is 510's lesson from a new angle —
      there the wrong answer was a superstring of the right one, here
      one member's witness is another member's.
      So the replacement is a table with ONE MINIMAL SNIPPET PER
      MEMBER, and the verification is the method point: each snippet
      was checked to flip under its OWN member and no other, 22 of 22,
      one-to-one. Without that check a table looks thorough and proves
      nothing — exactly the state the `await import` row was already
      in. Asserted as the whole list (505) with a pure control, so no
      member can pass on another's account.
      THE STRIPPER'S REFUSAL, pinned separately. `stripLiterals`
      answers null for source it cannot scan — a regex literal (a bare
      `/` it will not parse), an unterminated string. The deny-list
      never sees that source, so the null IS the guard. Without it the
      code does not merely mis-cache: it throws on `null.includes`.
      Flapper note: the pristine control carried `armWatcher > proves
delivery with a probe it then removes (recursive: true)` — the
      sibling of the `recursive: false` entry already on the list.
      Tenth instance of that family across six sweeps; still three
      listed, still not added.

519.  DONE (2026-09-21, `orchestrator/execute-task.ts` — eleventh by the
      age rule, 846 lines, and the file CLAUDE.md marks stale-hit
      critical. Its own header says it: "Eight separate stale-hit
      defects in the decision log route through this file").
      Too large to sweep whole, so the scope was the SAVE-ELIGIBILITY
      guards — the decisions whose failure is a stale hit rather than a
      visible error. 13 mutations over `willWrite`'s four conjuncts,
      the `willSave` taint gate, the capture coupling, and both save
      sites' exit-code gates.
      TWO SAVE SITES, ONE PAIR OF GATES, AND ONLY ONE SITE WITNESSED.
      `effectiveExitCode === 0 && willSave` guards an if/else-if pair
      differing only on `deferralRequested`. The EAGER branch's gates
      are held by rows that already existed. The DEFERRED branch's
      identical gates were held by NOTHING — and that is the branch
      that hands a closure to a later consumer to pull bytes with.
      Registering there on a failure caches a failed task's outputs;
      registering on a tainted run caches bytes built on a partial tree
      under the key a HEALTHY run derives, which is the stale hit the
      `taintedUpstream` docblock spells out. 517's lesson again, in the
      file where it costs most: when a rule has two copies, sweep both,
      and expect the newer one to be the bare one.
      The missing fixture was a shape no test built: a non-zero exit
      WITH deferred outputs. That is what a real remote executor
      produces — it ran the command, got a failure, and still holds
      output blobs in CAS. `download-policy.test.ts` has a
      `failProducer` flag, but it returns the failure WITHOUT deferred
      outputs, so the combination never existed.
      AND A REMOTE-WRITE-ONLY RUN SAVING NOTHING. `willWrite` reads
      `(policy.localWrite || policy.remoteWrite)`; read only the local
      axis and a remote-write-only policy cleans nothing and saves
      nothing. The run is green and the cache stays empty — the
      quietest way for a remote cache to be useless. Pinned.
      FOUR ROUNDS OF FIXTURE ERROR, all the same class, and the fourth
      is the one worth keeping. (1) The suite list for the pre-check
      omitted `download-policy.test.ts`, the only file that drives the
      deferred path at all. (2) The fake executor returned deferred
      outputs but wrote no file, so the run failed on a missing
      declared output instead of on the gate. (3) The `deferred` stub
      had only `register`; execute-task also calls `materializeFor`, so
      the run died with a TypeError. (4) THE CONTROL DID NOT REGISTER —
      deferral is requested by `args.download === 'deferred'`, not by
      the result's shape, so without it the two refusals were asserting
      on a path that never fires. A row that cannot fail (514), reached
      by a new road: not a weak assertion, but a fixture that never
      entered the branch. The control is what exposed it.
      CLASSIFIED, NOT PINNED. `cfgCacheable`'s conjunct: an uncached
      task has no declared outputs, so the clean is a no-op and the
      save writes nothing either way — no observable difference
      measured. And the two `capture` mutations: the comment is
      explicit that retaining a stream costs "its full byte size in
      heap" and that `cache.save` is stdout's only consumer while
      stderr has none, so making capture MORE retentive is a memory
      regression with no observable behaviour. The repo's own rule says
      a perf claim needs a number, not a row.

520.  DONE (2026-09-21, `exec/sandbox-binds.ts` — twelfth by the age
      rule, newest dated comment 2026-09-09. The write-grant boundary:
      which paths a sandboxed task may write. The SILENT direction here
      is too WIDE — too narrow fails loudly, because the task cannot
      produce its declared output).
      10 mutations. Five survived the file's own suite; two are real
      and now pinned, three are classified.
      THE SIBLING PREFIX, AGAIN. `punchWritePaths` decides what is
      under a read grant with `w.startsWith(readPath + path.sep)`. Drop
      the separator and a write grant on `<dir>-out` counts as being
      INSIDE `<dir>`: the read grant is punched apart into its
      children, which costs the directory ENTRY — exactly what makes a
      command that stats its own cwd die (`bun build`, per the file's
      own note). This is 514's `anchor-sep` in a second file, and the
      existing row misses it for a precise reason: it uses
      `/elsewhere/out`, an unrelated absolute path that fails
      `startsWith` OUTRIGHT and so never reaches the cut. A sibling
      sharing the prefix is the only member that discriminates it.
      THE GLOB THAT BECOMES A DIRECTORY. `bindableWrites` widens a
      FILE-shaped grant to its directory, deliberately — bwrap cannot
      rename onto an active mount point, so a file bind breaks every
      atomic writer. A GLOB is neither file nor directory: `statSync`
      throws on it, and without the glob check it falls through to
      `path.dirname`, so `dist/**` reaches SRT as `dist`. The pattern
      the user wrote is replaced by a plain directory.
      A PROBE THAT CONTRADICTED A SIGNAL I ALREADY HAD. My first
      `buildCustomConfig` probe read `filesystem.writePaths`, which
      does not exist — so it reported NO DIFFERENCE for all three
      `bindableWrites` mutations, including the two the per-file
      pre-check had already proven are CAUGHT by tests. That
      contradiction is what exposed it: an independent signal
      disagreed, so the probe was wrong, not the code. The field is
      `allowWrite`. Had I probed only the one mutation I suspected, "no
      difference" would have read as a clean equivalence and a real gap
      would have been classified out of existence. When a probe and a
      verdict disagree, the probe is the suspect — and running a
      mutation you KNOW is caught is the cheapest way to find out.
      CLASSIFIED, NOT PINNED. `w !== readPath`: measured redundant —
      `readPath.startsWith(readPath + sep)` is false, so the equality
      check can never change the answer (502's "strictly wider, so
      redundant is right"). And both `process.platform !== 'linux'`
      early returns: on this box the guard never fires, so removing it
      changes nothing measurable here. They are macOS behaviour and
      this platform cannot discriminate them — said plainly rather than
      counted as equivalents.

521.  DONE (2026-09-21, `orchestrator/history.ts` — thirteenth by the age
      rule, newest dated comment 2026-09-09. The bounded window the
      `schedule` plugin orders by and `--dry` predicts from. Every
      wrong answer here is SILENT: a p50 off by an order of magnitude
      re-orders the critical path and nothing says so).
      18 mutations. Nine survived the file's own suite; four are real
      and now pinned in three rows, five are measured equivalents.
      THE EXCLUSION THE DOC PROMISES AND NOTHING HELD. `p50DurationMs`
      is documented "Cache-hit rows excluded so this reflects work
      actually done", and the percentile fixture DOES carry a hit —
      it just cannot tell the answers apart. Three executed successes
      at 100/200/300 plus a 5 ms hit: including the hit adds a value
      BELOW the answer and shifts the index up by exactly one, so p50
      stays 200 and p99 stays 300. A fixture can reach the mutated line
      and still agree with it by arithmetic. One execution against
      three near-free hits does not agree: p50 goes from 100 to 1.
      LEXICOGRAPHIC ACROSS DIGIT COUNTS. `durations.sort()` without the
      comparator is the classic, and every fixture in the file spans a
      single digit count, where the lexicographic order IS the numeric
      one. Over 1..100 it is not: p50 reads 54 instead of 51. The same
      100-sample fixture is the fewest that puts the 95th and the 99th
      percentile on different values (96 vs 100), so it pins the
      percentile the field is named for as well.
      A READER CORRECT ONLY BECAUSE OF WHAT THE WRITER OMITS.
      `attempts > 1` is the retry signal, and `execute-task` writes the
      column ONLY when it exceeds 1 — so every row in every fixture
      leaves it NULL, `NULL >= 1` is NULL, and `> 1` was never told
      apart from `>= 1`. Normalise the writer to always record the
      count (the schema comment invites it) and `>= 1` marks every
      green task in the history flaky-recoverable, because
      `failureModeOf` takes `retried > 0` as proof of nondeterminism on
      its own. The row puts the meaning on the reader's side: a row
      with `attempts: 1` is stable, with a sibling at `attempts: 2`
      as the control that the column reaches the query at all.
      MEASURED EQUIVALENT, NOT ASSERTED. The `Math.min` percentile
      clamp cannot fire — `floor(q * n) <= n - 1` for every q < 1,
      checked over n up to 200 000. `duration_ms > 0` does not guard a
      division by zero: SQLite returns NULL for `x / 0` and `MAX`
      drops it (probed). The `cache_hit = 1` join gate is cost only —
      `entries.hash` is the PRIMARY KEY so the join cannot fan a row
      out, and the CASE never reads `e` on a non-hit row. The
      mixed-outcome pre-filter is the same shape: `failureModeOf` takes
      the count as a thunk, so a wider map changes no verdict. And
      `total > 0 ? … : 0` is unreachable — `total` is `COUNT(*)` under
      a `GROUP BY`, so a group that exists has a row in it.

522.  DONE (2026-09-21, `cli/init.ts` — fourteenth by the age rule and
      the last of the 2026-09-09 band. 75 lines, almost all forwarding,
      which is exactly why it is worth saying that EIGHT of fourteen
      mutations survived: a file being small is not the same as a file
      being held).
      THE REFUSAL HELD ONLY ITS MESSAGE. Both existing rows assert that
      the error of `parseInitArgs([x])` CONTAINS x — and every branch
      satisfies that. Weaken the exact match to a prefix and `--dryrun`
      is accepted AS `--dry`, its error gone; test the dash with two
      dashes instead of one and `-d` falls to the positional message.
      Neither changes what the error mentions, because what changed is
      WHICH refusal. The table now names the branch per argv shape, and
      carries the help pointer as part of the answer: the unknown-flag
      message ends in a pointer at the verb's help and the
      unexpected-argument message does not, which is the distinction
      a single-dash flag turns on.
      AND THE TWO THINGS A CALLER ACTUALLY READS. The cli row named for
      a bad argument to init pointing at its help reads the message and
      stops there. The exit code and the stream were held by nothing: a
      `vx init --bogus` that returns 0 is a CI step carrying on as if
      the workspace had been scaffolded, and the same text on stdout is
      a refusal piped into whatever consumes the scaffold. Measured:
      exit 1, stderr, stdout empty, nothing written.
      THE ROOT IT SCAFFOLDS IN. `init` resolves the workspace root
      before it plans, and no test had ever run it from INSIDE a
      package. Take `process.cwd()` for the root instead and the
      workspace file lands in the package directory — a second
      workspace nested in the real one, which is left untouched, with a
      zero exit and no word. Measured from a package: the workspace
      file at the root, only the config in the package.
      TWO MARKERS IN ONE OR, AND NEITHER FIXTURE EXISTED. An Nx
      workspace is recognised by `nx.json` or by the exported graph
      under `.nx/workspace-data/` — 518's shape again, except here the
      stronger fact came first: grep says no core test wrote EITHER
      marker before this item, so the whole Nx branch was unreached and
      both disjuncts were droppable. One fixture per marker, plus the
      case the `else if` decides: a root holding both a turbo.json and
      an nx.json gets the turbo note and only that one.

523.  DONE (2026-09-21, `orchestrator/execute-task.ts` — the half 519
      left. 519 took the save-eligibility guards; this is the ATTEMPT
      LOOP: the pre-exec wipe, the violation and timeout
      classification, and abort versus failure. 18 mutations, nine
      per-file survivors, SIX of them still standing at whole-suite
      scope: five are now pinned across three rows and one is measured.
      TWO COPIES OF ONE RULE, EACH MASKING THE OTHER — a fourth time,
      and the cleanest instance yet. The attempt loop reuses one
      `violations` array, kept honest by a reset at the top of
      `runAttempt` AND a whole-array assignment after the executor
      returns. Either alone suffices, so mutating either alone changes
      nothing and BOTH survive the whole suite individually. Mutating
      the pair together also survives — which is the actual finding:
      the guarantee had no witness at all. Drop both and a first
      attempt's denial re-fails a clean retry, carrying lines from an
      attempt that is over onto an outcome that tripped nothing.
      A ROW THAT ASSERTS THE GUARANTEE AND CANNOT FAIL. `signal-death`
      has a row named for vx's own timeout keeping its line and getting
      no signal verdict, with the exact negative assertions. It cannot
      fail: its child is really SIGTERMed, so the runner reports the
      signal and `signalVerdict` declines any SIGINT or SIGTERM handed
      to it — a SECOND copy of the same rule, inside shell-verdict.
      Measured: a 143 with the signal present answers undefined, a 143
      with no signal answers a verdict. The trap-exit-0 timeout is the
      shape that reaches the second copy: the child exits 0, the runner
      sees no signal, execute-task rewrites the code to 143 itself, and
      shell-verdict then calls that "128 + 15, something outside vx
      asked the process to stop" — printed directly beneath the line
      saying vx's own deadline killed it. The suite already had the
      trap fixture; it asserted the classification and never the
      contradiction.
      THE ROOT-ANCHORED TWIN OF THE WIPE. `cleanWorkspaceOutputs` had
      no witness: disable it outright and nothing in the suite moved,
      while its per-project twin is held by a named stale-hit row. Now
      mirrored — the same producer/consumer shape over
      `cache.outputs.workspaceFiles`. A fixture note worth keeping: the
      `files` array is REQUIRED on both inputs and outputs even when
      only the workspace arrays carry globs, so the mirror needs an
      explicit empty one or the config is refused.
      THE SANDBOX CONTRACT IS THE TASK'S OWN DECLARATION. Fail-on-
      violation is scoped to a task that declared `exec.sandbox`.
      Dropping that scope is silent in-tree because the local executor
      reports no violations unless it sandboxed — only a plugin can
      reach it, so only a fake executor can pin it.
      MEASURED, NOT PINNED. `markWorkspaceOutputsChanged`: dropping it
      leaves the answer CORRECT on the very shape that discriminates
      its per-project twin (run it and the consumer still empties), and
      no shape was found where it changes the answer. Said as measured
      rather than written up as a gap or given a row that cannot fail
      (514). The new wipe row does reach that region — it catches the
      wipe itself — so this is a non-discriminating line, not an
      unreached one.
      AND THE PRE-CHECK WAS WRONG AGAIN. Of nine per-file survivors,
      three were already caught at whole-suite scope: the per-project
      output mark by a stale-hit row, and two violation mutations by
      sandbox rows in `test.bun.unsafe`. Fourth item running where the
      whole-suite step deleted a claim the per-file pass would have
      made.

524.  DONE (2026-09-21, `orchestrator/signals.ts` — 122 lines, dated
      2026-09-10 and NEVER swept: grep finds zero mentions of it
      anywhere in this file's 523 items. The failure direction is an
      orphaned process tree, which is silent by construction — vx exits
      with the right code and the user never sees what it left running
      under init.
      19 mutations. Ten survived the file's own suites and nine
      survived the whole suite; two are pinned and seven measured.
      THE SECOND SWEEP RE-READS. `terminateChildren` SIGTERMs what
      `live()` returns, waits the grace, then SIGKILLs what `live()`
      returns NOW — and the comment says exactly why: the run loop may
      still be dispatching during the grace, so a child spawned after
      the first sweep must not survive the second. Nothing held it,
      for a reason worth naming: every fixture in the suite has a child
      set that is FIXED for the whole teardown, so reusing the first
      list gives the same answer in every one of them. Driving
      `terminateChildren` directly with a `live()` that GROWS between
      sweeps is the only shape that tells them apart.
      AND THAT ROW DID NOT REACH THE CODE ON THE FIRST TRY. It hung to
      its 20-second timeout, because `killTree` signals the process
      GROUP (a negative pid) and that only reaches a child spawned
      `detached` — which is how the runner spawns every task. A plain
      `Bun.spawn` child sits in the TEST's group, the negative pid
      names no group of its own, nothing is killed and the awaits never
      settle. The probe has to be spawned the way the thing under test
      spawns, or it proves nothing; here it at least failed loudly
      rather than passing for the wrong reason.
      TWO SIGNALS, ONE CODE. The existing second-signal row sends
      SIGINT twice, so "exit with the FIRST signal's code" and "exit
      with the second's" both give 130 and it cannot tell them apart —
      the same blind spot 518 found in a deny-list and 523 found in a
      timeout. SIGINT then SIGTERM discriminates: 130, because the
      SIGINT is what ended the run.
      MEASURED, NOT PINNED. The persistent registry's term in
      `everyChild` is REDUNDANT on the signal path: run.ts's own
      comment says persistent children stay in `liveChildren` until
      they exit, and the row that asserts a ready persistent child dies
      passes with the registry term removed. It is load-bearing at
      end-of-run shutdown, not here. The rest are timing claims or
      exit-path hygiene with no observable answer in a non-TTY harness:
      the final reap, SIGTERM versus SIGINT on the first sweep, the
      cleared grace timer, the env-read default, the cache close and
      the runEnd call.

525.  DONE (2026-09-21, the two files of the 2026-09-10 band that 524's
      grep showed had NEVER been swept, taken in one item because both
      are small: `orchestrator/save-lane.ts` (47 lines) and
      `cli/core-alias.ts` (25, of which 7 are code).
      SAVE-LANE IS A ZERO-YIELD REPORT, AND THAT IS THE RESULT. 12
      mutations, ELEVEN caught by the file's own suite — the cap off by
      one, the cap removed, the running set not added to or not deleted
      from, the settle dropped, the queue drain dropped, the queue read
      LIFO, the catch dropped, the catch rethrowing, and both ways of
      weakening the drain. The twelfth is measured equivalent:
      reordering the settle ahead of the delete cannot be observed,
      because the settled promise's continuation is a MICROTASK and the
      delete is the next synchronous statement — probed, not argued.
      A file that is actually held is worth saying plainly, in its own
      item, rather than leaving the next sweep to rediscover it.
      THE LAZINESS THAT WAS ONLY A COMMENT. `core-alias.ts` serves
      `@vzn/vx` from the host's own façade, and its docblock gives the
      lazy loader a reason: a verb that never loads a plugin never
      loads the façade — core's whole source transpiled again, 20–25 ms
      per plugin package in the binary. Both existing rows IMPORT
      through the alias, so neither can tell a lazy loader from an
      eager one: resolving the loader at registration, or once inside
      `setup`, serves the same exports and passes them both. Two ways
      to break it, neither held.
      A DURATION MADE INTO A LINE. The repo's rule is that a perf claim
      needs a number and not a row, and this one looks like a perf
      claim — but the guarantee is not "fast", it is "not loaded at
      all", which is a boolean. The loader prints a marker, so the row
      asserts an absent line rather than an elapsed time: registered
      and never imported prints REGISTERED then DONE, with the control
      being the same entry that DOES import and prints LOADED between
      them.
      CLASSIFIED. The Bun plugin's own `name` field survives every
      suite and has no consumer in this repo — cosmetic, said as such.

526.  DONE (2026-09-21, `orchestrator/miss-save.ts` — stale-hit-
      critical by its own header, and swept only in part: 508 took its
      empty-artifact WARNING and nothing else. 18 mutations, thirteen
      survived the file's own suites and TEN the whole suite; three
      pinned, seven measured.
      THE WARNING 508 PINNED ON ONE ARRAY OF TWO. The predicate counts
      both output arrays on BOTH sides — declared and resolved — and
      every fixture in the suite declares only `files`. Two edges fall
      straight out: a task whose whole output declaration is
      root-anchored never warned at all, and a task whose `files`
      matched nothing while its root-anchored glob DID match would have
      warned about an artifact that is not empty. 523's twin shape, in
      the file 508 had already visited.
      AND THE EDGE BETWEEN THE TWO EXISTING SANDBOX ROWS. The cause
      clause asks whether the task granted any write, and its two rows
      compare "no allow block at all" against "one path". An explicit
      empty write list sits between them: read the question as "is
      there a key" instead of "does it grant anything" and the clause
      goes quiet for exactly the task it was written for. The fixture
      helper took a string or undefined, so the empty array was
      UNCONSTRUCTIBLE — widening it to take an array is the whole
      change.
      A FINDING I TALKED MYSELF OUT OF, BY MEASURING. Recording the git
      marks as ABSOLUTE rather than project-relative looked like the
      sharpest result here: dropping the marks is caught by four rows,
      while recording them under a useless key is caught by none, which
      reads as "the rows prove the mark happens, not that it lands".
      It is not a stale hit. `recordChanged` does two things, and the
      one that prevents the stale hit deletes the trusted index OID
      under `path.resolve(partitionDir, rel)` — idempotent on an
      absolute input, so the OID is still dropped under the right key
      (probed). Only the changed-path LIST gets entries a
      project-relative glob cannot match, which moves the re-spawn
      decision and not the answer. That is a perf difference, and the
      rule here is that a perf claim needs a number rather than a row.
      MEASURED, NOT PINNED. The input-component spread order is
      provably equivalent — `TaskInputComponent` has no `entryHash`
      field, so the two orders cannot disagree. The rest are the
      always-pass-the-workspace-arrays form, the queued-versus-now
      directory snapshot (whose cost the docblock already quantifies at
      296 ms), and the workspace-partition mark family. That family has
      now resisted discrimination in two items running — 523 measured
      its clean-path twin the same way — so what is true is that I have
      not built a shape that tells it apart, NOT that the line is dead.

527.  DONE (2026-09-21, `util/paths.ts` — the pure-function core whose
      own comments cite four past defects (441, 442, 445, 495), each a
      stale hit or a pair of tasks deleting each other's outputs. 495
      touched it only in passing. 25 mutations, NINETEEN caught by its
      own suites; the six survivors split cleanly in two.
      FOUR GUARD WHAT THE SCHEMA ALREADY REFUSES. A `cache.inputs` or
      `cache.outputs` glob is validated relative, non-escaping,
      non-negated, and not the directory itself. So the negation
      exclusion in the whole-subtree regex, its absolute and `..`
      refusals, and the empty-literal skip in `asTrees` all guard
      shapes that cannot arrive through a config. Defence in depth,
      right to keep, and not a testable gap — a row for any of them
      could not fail by any supported path. The `.` refusal is
      narrower still: no spelling survives `normalizeGlob` as a bare
      dot, so it cannot fire at all.
      AND TWO ARE NOT, BECAUSE A SANDBOX GRANT IS NOT A CONFIG GLOB.
      `exec.sandbox.allow.read` is checked only for being an array of
      strings, deliberately — an absolute grant is the POINT, since
      macOS matches patterns natively and Linux expands them against
      the filesystem at resolve time. So a grant of `/` or of the
      root-anchored everything reaches `staticPrefix` unfiltered, and
      both trim to the EMPTY STRING once the root case is gone.
      `sandbox-request.ts` hands that result straight to `expandHome`
      as a read path, where an empty string is not the root — it is
      whatever the cwd makes of it. Every existing row feeds this
      function a project-relative glob.
      THE METHOD NOTE, AND IT COST THE ITEM'S HEADLINE. This was
      written up as a second zero-yield report — all six survivors
      "already refused at the boundary" — and that was wrong for two of
      them. What corrected it was enumerating the CALL SITES instead of
      stopping at the config validator: `staticPrefix` has four
      callers and two are sandbox grants, which take a different
      validation path entirely. A boundary argument is only as good as
      the list of doors, so count the doors before trusting it.

528.  DONE (2026-09-21, `orchestrator/placement.ts` beyond
      `pinnedLocalSet` — 507 swept that one predicate and stopped, and
      the other 140 lines decide where every task runs and which
      outputs come home. 15 mutations.
      THE PRE-CHECK NAMED THE WRONG FILE, AND THE VERDICT SAID SO ON
      ITS FIRST BATCH. The per-file suite got `executor.test.ts` — the
      name that sounds right — and missed
      `plugin-capabilities.test.ts`, which actually holds the placement
      end-to-end rows. Fourteen of fifteen mutations "survived"; with
      the right file it is seven caught. The whole-suite step flagged
      it immediately, returning two rows for a mutation recorded as a
      survivor a minute earlier. 519's lesson in a new place: the suite
      list is itself a fixture, and a wrong one MANUFACTURES gaps.
      ONE RULE, TWO COPIES, AND NEITHER WATCHED. `localPlaced` — these
      tasks wrote in place, so their outputs are already here — was
      built inline in `run()` and again in the `--dry` planner, from
      the same predicate. Mutating either alone survives, and mutating
      BOTH together survives too. `remote` is three-state (true, false,
      undefined) and core's own floor declares none, so asking "is it
      declared local" instead of "is it not remote" drops every task on
      the floor executor — every task in a workspace with no executor
      plugin — and vx then believes it must fetch their outputs from a
      CAS that never held them. The download tests hand the finished
      set in as a literal, so nothing ever watched how it was BUILT.
      Fixed the way this repo fixes second copies (441, 442, 445): one
      exported `locallyPlaced`, both call sites on it, and two rows —
      the floor executor, and a task with no placement at all.
      AND THE STAND-IN THAT REFUSES. `UNPLACED_EXECUTOR` exists to
      throw rather than pick an executor, so a refactor routing a group
      or persistent task through the exec path fails loudly "instead of
      shipping a localhost server to a worker" — asserted nowhere, so a
      stand-in that quietly returned success would have read as a green
      run. Writing the row also surfaced that it throws SYNCHRONOUSLY
      though `execute` is typed as returning a promise, so
      `execute(req).catch(...)` in execute-task never sees it. Right
      shape for a refusal nobody should handle; recorded because the
      first draft of the row asserted a rejection and failed.
      MEASURED: A DEAD PARAMETER. `placeTasks` takes `pinAllLocal`, and
      NO caller anywhere passes it true — both call sites in the repo
      pass false or omit it, across every package's source and tests.
      The disjunct cannot fire, so no row can hold it. Named for the
      owner as a de-claim candidate rather than counted as a gap.
      Classified: the persistent and group skips, the `cacheable` hint
      to `selectExecutor`, the `--dry` policy gate, and the two pool
      accessors.

529.  DONE (2026-09-21, `cli/run.ts` — 674 lines and ONE mention in
      this file's whole history, so the least-swept large file left.
      Too big to take whole, so the scope is the region where a wrong
      answer is silent and expensive: what `--cache`, `--no-cache` and
      `--force` resolve the four cache axes to. 12 mutations, seven
      caught by the flag suites, five survivors — and the whole-suite
      step then took one of those back.
      THE WARNING THAT WAS ALREADY HELD. Dropping `remoteRequested`
      entirely looked like the find: it arms the one line that says
      `--cache` named the remote cache while no plugin supplies one, so
      losing it leaves the remote axes quietly off. A TURBO-PARITY row
      holds it, named for Turbo's own "Remote caching disabled". Ninth
      item running where the verdict deleted a claim the per-file pass
      would have made.
      WHAT IT DID NOT HOLD IS THE OTHER DIRECTION. That row spells its
      spec with an `r`, so it only ever proves the positive: widen the
      test from a remote AXIS to the remote LAYER and `--cache=remote:`
      — the spelling that turns remote caching OFF — arms the warning
      too, telling the user who explicitly disabled it that they asked
      for it. The character class is the whole distinction.
      AND THE TWO EDGES EITHER SIDE OF THE EMPTY SPEC. The refusal of
      an empty `--cache` is held for the bare form and for `,,`.
      Whitespace is not: an unquoted shell variable can expand to a
      SPACE rather than to nothing, which is the same intent, and only
      the trim says so — without it the spec is accepted, applies
      nothing, and leaves all four axes on, which the comment already
      names as the opposite of the intent. The other side is the
      `some`: it asks whether ANY segment carries something, and
      turning that into EVERY rejects `local:r,` — a trailing comma is
      sloppy, not empty, and the refusal would turn a working spec into
      an error.
      MEASURED EQUIVALENT. Swapping the two precedence blocks changes
      nothing: `--no-cache` sets all four axes false and `--force`
      clears only the two reads, so either order ends in the same
      place. The row named for the precedence is about ARGV order, not
      statement order, and it is right not to care.

530.  DONE (2026-09-21, `cli/run.ts`'s SELECTION region — the half 529
      did not take. `--filter`, `--all`, `--affected` and the retired
      spelling decide WHICH PROJECTS RUN, so a wrong answer runs the
      wrong set and reports success over it. 10 mutations, EIGHT caught
      by the flag and affected suites. A second zero-yield report, and
      this time the doors were counted before declaring one.
      WHAT IS ALREADY HELD, AND WORTH NAMING. The repeatable `--filter`
      is pinned three ways — an empty value refused, the order kept,
      and every occurrence kept rather than the last. `--affected`'s
      sugar is pinned as `...[base]` and not `[base]`, which is item
      287's own defect: the changed-only form is what the flag shipped
      with while the guides promised dependents. The bare `--affected`
      is pinned twice over, including against reading its empty-string
      base as falsy — the trap in `if (parsed.affected)` — and the
      retired camelCase spelling still names its replacement.
      BOTH SURVIVORS ARE MEASURED, NOT ASSUMED. The filter array is
      COPIED before `--affected` appends its sugar, and aliasing it
      instead really does mutate the parsed args. It cannot change an
      answer: `detectFlow` is the only reader after that point, it runs
      at line 492 against a push at 442, and its predicate already ORs
      in `affected !== undefined` — true in exactly the case the
      injected element appears. Fragile rather than wrong: drop that
      disjunct one day and the aliasing would hide it.
      And the error-class guard on the default base re-throws anything
      that is not a UserError. `defaultAffectedBase` has exactly ONE
      throw site and it is a UserError, so the guard cannot fire today;
      it defends against git itself failing under the spawn, which no
      supported path produces. Defence in depth, named as such.

531.  DONE (2026-09-21, `cli/run.ts`'s LIMITS AND ENUMS — the third and
      last region of the file, after 529's cache policy and 530's
      selection. `--timeout`, `--retry`, `--continue`, `--output-logs`,
      `--download` and `--cache-dir` between them set real execution
      limits and decide what a failure takes down. 13 mutations, ELEVEN
      caught; both survivors are the same shape.
      ONE MEMBER OF A LIST, AGAIN. `--continue` takes its mode with an
      `=` only, because `--continue never` would read the mode as a
      TASK and end in "No projects declare task(s): never" — the
      comment says exactly that. The refusal looks ahead for any of
      three modes, and the row that covers it spells ONE: drop
      `deps-ok` from the lookahead and nothing moves, because no
      fixture ever writes that mode in the space form. Same for
      `--download`, whose guard lists three modes and whose rows cover
      `all` and `toplevel`: `none` — the form that keeps every
      intermediate output remote — had no assertion anywhere, so
      deleting it from the guard turns a documented mode into an
      argument error. 518's deny-list and 526's write grant, a third
      and fourth time, in flags this time: one argv per member.
      WHAT IS HELD, AND WORTH THE LINE. The timeout ceiling is pinned
      three ways — past 2^31-1 `setTimeout` fires at 1 ms, so a value
      above it would kill every task the moment it spawned, and the
      bound is refused rather than clamped. `--retry` rejects a
      negative through `parseDecimalInt` rather than `Number`.
      `--cache-dir` still refuses a flag-shaped value in the space
      form, which is what keeps an unquoted empty shell variable from
      creating a directory named `--force` and swallowing the flag.

532.  DONE (2026-09-21, `workspace/config-schema.ts`'s GLOB REFUSALS —
      850 lines, and 490 took only its timeout pairs. Picked because
      527 leaned on exactly these rules: four of its six survivors were
      classified unreachable BECAUSE the schema refuses absolute,
      escaping, negated and directory-naming globs. If those refusals
      are themselves unheld, that classification rests on nothing. 8
      mutations, three caught, FIVE survivors, four of them real.
      THE ESCAPE HATCH WAS HELD FOR ONE SHAPE OUT OF THREE. The `..`
      refusal exists, in its own words, because a glob leaving the
      project dir "would let cleanOutputs delete files outside it" —
      the run deletes declared outputs before every attempt. Every
      fixture spells that escape as a LEADING `../`, so narrowing the
      whole-segment scan to a prefix test changes nothing the suite can
      see, while `dist/../../etc/**` walks straight out of the
      workspace. Inner, inner-twice and leading are three different
      argv, and only the first had one.
      AND THE MARKER COMES OFF FIRST. Inputs may be negated, so both
      predicates strip a leading `!` before they look. Nothing held
      either: `!..` splits to a single segment that equals no segment
      at all, and `!.` reads as a name rather than as the directory
      itself. Two more members, two more argv.
      THE CONTROL THAT KEEPS THE REFUSAL HONEST. A segment must EQUAL
      `..`, not begin with it — widen the test and an ordinary
      `..foo/**` directory is refused. That direction is loud rather
      than silent, and it is the reason the row asserts an ACCEPT.
      MEASURED UNREACHABLE. `namesDirItself` also answers true for a
      bare `/`, and no call site can reach it: all three loops refuse
      an absolute glob BEFORE they ask, so every `/` is already gone.
      Checked at each of the three, not argued from one.
      WHAT THIS SAYS ABOUT 527. Its classification stands — the shapes
      really are refused — but the refusals were held more thinly than
      the argument assumed. A boundary argument needs the boundary
      itself under test, not merely present.
