# Shipped, 2026-09 — improvement-loop items 473–492

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
`2026-09-improvement-loop-453-472.md`; items 493 onward continue in
`docs/STATUS.md`.

473.  DONE (2026-09-20, the two threads 471 left OPEN in
      `orchestrator/hit-restore.ts`). Both close, and ONE OF THEM
      CORRECTS 471's own report.
      (b) FIRST, THE CORRECTION. 471 recorded the post-restore
      `markOutputsChanged` as an unmeasured survivor. It is not a
      survivor: removing it fails
      `restore-path git spawns > overlapping globs keep the re-spawn
fallback (and stay cache-hits)`. 471's fast filter simply did
      not include `restore-git-spawns.test.ts`, and the whole-suite
      run says so. That is 466's lesson — a fast-filter survival is
      PROVISIONAL — landing for the third time in this arc, and this
      time it reached a shipped STATUS entry before the whole-suite
      run caught it. Read 471's "open" line as closed and wrong.
      (a) `covers` in the directory short-circuit is genuinely
      unpinned, and it guards a state that cannot arise. Three
      fixtures failed to build one before the right question turned
      up, which was not about the reader at all: `recordOutputDirs`
      is ALL OR NOTHING in one transaction — it deletes every row for
      the hash, then inserts the full set only if every prefix walked
      and none is racy-young — so the only states are COMPLETE and
      EMPTY. The empty case is already refused by
      `outputDirsCurrent`'s own `rows.length === 0`, which its row
      pins; the complete case is what `covers` tests for and always
      finds. The instrumented probe is what settled it: after deleting
      one row by hand the next hit read `rows=[]`, not a partial set.
      So `covers` restates, on the read side, an invariant the WRITER
      holds — and the writer is well pinned: inserting partial rows on
      a failed walk fails two rows, never clearing stale rows fails
      two, dropping the racy-young check fails one.
      Recorded, not pinned, for 471(c)'s reason: the guarantee is
      already held at its source, and a second pin on the reader would
      duplicate it. Unlike 463, where the layer WAS the guarantee and
      nothing else carried it.
474.  DONE (2026-09-20, `cache/inputs.ts` — 818 lines, the largest
      unswept file and the resolver every cache key is built from).
      The fast filter was built from `grep -rl` per exported symbol
      and every path checked to EXIST first, which is 473's amendment:
      `bun test` ignores a path that is not there and reports a clean
      pass meaning nothing (469 and 473 both).
      Six mutations, four caught, and the project boundary is held
      hard — principle 6 in the tests as well as the prose. Dropping
      `boundaryIgnorePatterns` fails EIGHT rows, one of them "a
      sibling whose name EXTENDS the nested project's name is not
      excluded"; dropping it from the OUTPUT side fails three. The
      per-declaration memo is pinned both ways: a key that forgets the
      task's own outputs fails a row, and comparing snapshots by
      length instead of identity fails the row named for it.
      THE FIND is the memo's COPY. The resolver stores `resolved` and
      returns `[...resolved]` on both the store path and the memo-hit
      path, so what a caller receives is never what the cache holds.
      Return `memo.result` directly and the repo stays green, because
      no caller mutates today — a property of today's CALLERS, not a
      guarantee, and nothing else carries it. The memo is shared by
      every task in the project, so one caller sorting or splicing in
      place rewrites what the next task resolves: a wrong input set,
      therefore a wrong key. Pinned as the guarantee itself (463's
      genre, not 473's): a caller mutates what it was handed and the
      next call must still see the real file.
      Left unpinned, measured: the memo key's boundary component. The
      nested-project set is per project and the memo lives one run, so
      for a given `projectDir` that component is constant and removing
      it cannot change an answer. Redundant within the memo's scope.
      NOTED, not yet acted on: `output-memory.test.ts`'s `none`
      discard row failed on the first gate of this item. It passes 3/3
      alone and the immediate gate re-run was clean, so it is
      load-sensitive rather than broken — but both of its failures
      this session came AFTER 465 added two more subprocess probes to
      it, taking it from four to six. That is a plausible cause and
      not an established one. Next item.
475.  DONE (2026-09-20, the measurement row 474 saw go red, and a
      CORRECTION to what 474 said about it).
      474 recorded the failure as load-sensitive and floated 465's two
      extra probes as a plausible cause. Reading the actual assertion
      killed that theory: the probes 465 added run AFTER the `none`
      pair and cannot raise `noneMany`. The real number is the
      interesting part —
      `expect(noneMany - noneFew).toBeLessThan(80)` received 88 — and
      the row's own note estimated the noise at "~10x below" the
      bound, i.e. about 8 MiB. On this container under a full
      `vx run ci` it is 88. The calibration was taken from a quiet
      machine and the note said so ("a tighter 0.25 bound passed here
      and still failed on a loaded CI runner"); 0.5 is the same
      mistake one notch out.
      Fixed with MIN-OF-2 ON A MISS rather than a looser bound: the
      delta is re-measured once, and only when the first reading
      already exceeds the bound, so a quiet machine pays nothing. That
      is CLAUDE.md's own answer to a loaded measurement rather than an
      invention.
      It cannot mask a real regression, and that is measured, not
      argued: with `discardsOutput` forced false the delta is 160 —
      the FULL retained volume, every time — against a bound of 80.
      160 and 88 are two very different numbers, which is exactly why
      the bound stays sharp instead of being widened to swallow the
      noise it was never meant to cover.
476.  DONE (2026-09-20, `cache/git-inputs.ts` — 711 lines, the git
      enumeration the whole input resolver trusts, and the last large
      file in the cache module; 451 and 455 touched only parts of it).
      A WELL-HELD report with one cost survivor. Filter built from
      `grep -rl` over twelve exports, every path checked to exist.
      Five mutations, four caught, and what catches them is the
      stale-hit family itself. Letting a scoped enumeration accept an
      empty or `.` rel fails SEVEN rows, among them "a CRLF-to-LF
      change under a text filter is not served from cache", "a content
      change that preserves mtime is not served from the file-hash
      memo", "editing an assume-unchanged input moves the key" and
      "materialising a skip-worktree input moves the key". The scope
      decision is load-bearing for the whole OID-trust story, not just
      for speed. Scoping a workspace-wide run fails two; dropping
      `markOutputsChanged`'s forward to the workspace partition fails
      the row named for it; breaking `autocrlfConverts` fails its own
      row and "core.autocrlf alone is enough to distrust index OIDs".
      THE SURVIVOR is the 64-directory cap on scoping, and its own
      comment says what it is: "Above 64 dirs (or when a project IS
      the root) the whole-tree scan wins on arg/exec overhead anyway."
      A perf CROSSOVER, not a correctness rule — either side of it the
      enumeration answers the same, only slower or faster — so no test
      can catch it and none should. 469's genre.
      Worth noting rather than acting on: that comment carries a
      measured number for the scoping benefit (75 ms → 11 ms on an
      11k-file repo) and none for the crossover itself. Re-measuring
      where 64 actually sits is a perf task rather than a pinning one,
      and the number should stay free to move.
477.  DONE (2026-09-20, `exec/sandbox-runtime.ts` — 1034 lines, the
      largest unswept file in the repo, and `exec.sandbox` is how a
      task PROVES what it touched).
      Three mutations, none caught by the sandbox suites, and the
      useful work was deciding what each survival MEANS rather than
      reporting three findings.
      (a) `sbplToken` refuses a quote, paren or backslash in a value
      interpolated into a seatbelt profile — "refuse rather than
      escape", a security boundary of 463's shape. Its survival here
      says NOTHING: it is reached only through `macProfileRules`
      behind `platform === 'darwin'`, so a Linux box cannot execute
      it. The platform analogue of 473's missing file, and recorded as
      untested-here rather than unpinned.
      (b) `readableUnder`'s separator-terminated prefix, the same
      sibling-name class 474 found eight rows guarding. Here it feeds
      a DIAGNOSTIC — its own comment says it is "added only when the
      task ALREADY failed with nothing to show, so it can never redden
      a pass". Loosening it silences an explanation, it does not widen
      access. Recorded.
      (c) THE FIND. `expandGrants` collapses `<d>/**` to `<d>`, and the
      comment justifies it: the pattern "already covered every file
      there; it adds the directory entry". That reasoning is exactly
      what fails for `<d>/*`, which covers the immediate children and
      nothing deeper — folding THAT to `<d>` hands the task the
      directory itself and everything created in it later. Widening
      the regex by one star leaves the whole repo green.
      The `**` half is pinned e2e ("a whole-directory pattern grants
      the directory, so a task can list its cwd"); the single-star
      half had nothing. One boundary, one side asserted — 465, 469 and
      471 again, and this time the unasserted side is a GRANT. Pinned
      at `resolveSandboxConfig` with a control proving the shallow
      pattern still grants what it names.
478.  OPEN FINDING, not fixed (2026-09-20, following 477's carry-
      forward into `macProfileRules`). The seatbelt profile's
      injection boundary has a hole, and it is one line.
      `sbplToken` and `sbplPath` exist because a value carrying a
      quote, paren or backslash "could rewrite the policy or escape
      the argument", and the stated posture is to REFUSE rather than
      escape. Every interpolation in `macProfileRules` honours that —
      `systemInfo`, `machLookup`, and the declared socket path —
      except one:
      the unix-socket loop interpolates BOTH the checked declared
      path and `toRealPath(sock)`, and the resolved form goes in
      unchecked. `toRealPath` is `realpathSync` with a parent-walk
      fallback and sanitises nothing, so a symlink whose TARGET
      carries SBPL metacharacters puts them straight into the
      profile. The check is on the string the user wrote, the
      interpolation is of the string the kernel resolves, and a
      symlink is exactly what separates them.
      NOT FIXED HERE, deliberately. The one-line fix — wrapping the
      resolved path in `sbplPath` — refuses any path outside
      `[A-Za-z0-9._\-/@+]`, which includes a SPACE. Quoted SBPL
      handles a space fine, so that fix would refuse
      `/Users/Jane Smith/...` and regress a legitimate macOS layout
      to close a hole. The allowlist was written for values a user
      declares, not for paths a filesystem hands back.
      What a fix needs: refuse only what can leave the quoted string
      (quote, backslash, and the paren that ends the form), not the
      broader allowlist — and it must be exercised on macOS, which
      this container cannot do. Flagged rather than guessed at,
      because an untested change to a security path that also
      regresses ordinary users is worse than a recorded finding.
479.  DONE (2026-09-20, `exec/runner.ts` — 773 lines: spawn, kill
      grace, stream capture). Four mutations. The two guarantees the
      file states loudest are held exactly: removing the SIGKILL
      escalation in `armTimeout` fails "a timed-out task that IGNORES
      SIGTERM is SIGKILLed after the grace — the run is bounded, not
      hung", and letting `drainOrAbort` never abort fails "returns
      promptly when a backgrounded grandchild holds the pipe open (no
      hang)". Each names the hang its guard prevents; each has one row.
      THE FIND is in `SHELL_CONTROL`, the character class that decides
      whether `execWrap` may `exec` a command. Dropping BOTH separators
      `;` and `\n` fails five e2e rows — so the class looks covered.
      Dropping `\n` ALONE leaves the whole repo green: `;` carries the
      class, and the newline half has nothing. That matters because
      `exec` REPLACES the wrapping `sh`, so an exec-wrapped
      `a<newline>b` runs `a` and DROPS `b` — no error, exit 0. A task
      declaring a two-line command would report success having run half
      of it, and cache the half-built tree under a green key. Of the
      class's members only the separators can do that (`$`, `*`, `<`,
      `>` expand and redirect identically under `exec`; `(`, `{`, `!`
      turn into a loud syntax error), and of the three separators `&`
      and `;` were pinned while the newline was not — 465, 469, 471 and
      477 again, one boundary with a side unasserted.
      Pinned in `runner.test.ts` as the GUARANTEE first (a real
      `runCommand` of a two-line command must print both lines) and the
      mechanism second, so a regression reddens on the behaviour. The
      command is `/bin/echo`, not `echo`: a builtin would keep the
      shell for a SECOND reason and the newline guard could rot
      unnoticed — the same several-guards-one-guarantee arrangement 461
      and 468 needed. Differential both ways: with `\n` dropped from the
      class the row receives `['one']` where it expects `['one','two']`.
      Carry-forward, recorded not pinned: `shell-verdict.ts` is the
      second consumer of the same guard, where `execWord` names the
      program a 127 blames. Under the same mutation a multi-line
      command's 127 is attributed to its FIRST word whatever line
      failed — a wrong diagnostic riding the same regex, now held by
      the row above.
480.  DONE (2026-09-20, `orchestrator/execute-task.ts` — 846 lines, the
      file `CLAUDE.md` calls stale-hit-critical and the one every task
      passes through; never swept before). Six mutations, five caught,
      and the five are worth naming because each is a comment that
      claims a guarantee and each turns out to have a row that measures
      it. Dropping the taint guard (`willSave = willWrite &&
args.taintedUpstream !== true`) fails "--continue=always never
      caches a task built behind a failure". Letting a sandbox
      violation ride a zero exit fails two rows. Dropping the
      timeout's trap-exit-0 rewrite fails "a timed-out task that TRAPS
      SIGTERM and exits 0 is failed + NOT cached (no partial-output
      replay)" — the row names the replay its guard prevents.
      Silencing the matched-nothing warning and the untouched-
      placeholder clue each fail their own diagnostic row (470's
      lesson, held here already).
      THE FIND is `refresh`. `--force` means "re-execute everything
      (skip reads) but still refresh the cache", and vx's own cache
      honours it through the policy gates — but an EXECUTOR keeps its
      own record of what it has run, which no policy of vx's reaches
      inside. `ExecuteRequest.refresh` is the entire channel, set by
      one line in `buildRequest` when no read axis is on. Delete that
      line and the whole repo stays green.
      What makes it a hole rather than a gap: the CONSUMER half IS
      pinned — `@vzn/vx-reapi`'s "refresh (--force) bypasses the
      execution record and re-executes", with a control. But that row
      builds its own request, so it says nothing about whether core
      ever SETS the flag, and reapi is also the one suite that needs
      live service containers the gate cannot host. Two halves of one
      boundary, the load-bearing half unasserted, and the survival
      hides behind a row that reads as covering it — 471's
      wrong-survivor shape and 477's untested-platform shape meeting
      in one place.
      Consequence: `vx run --force` against a workspace with a remote
      executor is served that executor's cached answer, and the user's
      explicit re-execute is silently ignored on exactly the tasks
      that went remote. Pinned at the PRODUCER, in core, with a
      capturing executor: reads off sets it, the default policy does
      not (or every ordinary run pays a remote re-execution), and an
      uncacheable task never does. Differential BOTH ways — never set
      and always set each redden a different assertion of the row.
481.  DONE (2026-09-20, `cache/cache.ts` — 1637 lines, the largest file
      in the repo). Five mutations, three caught: letting
      `restoreOutputs` under-restore fails "throws when the artifact
      cannot produce an output the index recorded", expecting the
      workspace rows on a project-only restore fails "without
      workspaceRoot, restore materializes only the project namespace",
      and dropping `skipLocalWrite` fails "save packs the shared local
      artifact ONCE, not once per layer".
      FIND ONE, a diagnostic. Deleting the vanished-artifact check
      (`if (!exists) throw`) leaves the repo green, and the reason is
      that its guarantee is held TWICE: without it the decode reaches
      the same missing file and throws `CorruptArtifactError` from the
      extract catch. The row asserted `/corrupt artifact/i`, which both
      paths satisfy — 470's shape, `ok === false` for an incidental
      reason. What the check carries alone is the MESSAGE, and the two
      point at opposite remedies: "artifact file vanished before
      restore" (a prune raced this run — re-run) versus "artifact is
      not a readable archive" (the cache holds bad bytes — a reason to
      throw the cache dir away). Both messages read off a probe, not
      reasoned. The row now asserts the vanished one and carries a
      control proving a present-but-garbled artifact still reports the
      other; the source comment is de-claimed to say what it actually
      buys.
      FIND TWO came out of the fourth mutation and is the bigger one.
      Making `assertWritable` a no-op survives the whole suite — yet a
      row exists asserting its exact message. It is
      `it.skipIf(process.getuid?.() === 0)`, with a comment reading
      "CI's runner is not root". That comment is a CLAIM about the
      environment and NOTHING checked it. Six such rows across five
      suites assert what a permission bit does; root bypasses every
      permission bit, so on a root runner all of them vanish under a
      green check. Measured in this container: cache 3 skips,
      cache-dir-selection 4, inputs 1, watch-rules 2.
      That is exactly the silent pass `CLAUDE.md` names, and the repo
      already has the remedy twice — `VX_REQUIRE_SANDBOX` and
      `VX_REQUIRE_REAPI`, each turning an unavailable capability into a
      failure on the machine whose result gates a merge. Added
      `VX_REQUIRE_NONROOT` on the same pattern
      (`tests/helpers/nonroot-gate.ts`), set in CI, forwarded through
      both `passThrough` lists — a gate CI sets but the task's isolated
      env drops would be a no-op, which is the same defect one layer
      down. Differential, in this ROOT container: unset, each file
      skips as before; set, each file errors with the reason named.
      Follow-on, verified after the fact: CI came back GREEN with the
      gate on, so the hosted runner is not root and those ten rows
      genuinely ran there — the first check the claim ever had.
      But a gate is only OBSERVABLE when it fires. On a non-root runner
      `VX_REQUIRE_NONROOT` behaves identically whether it arrived or
      `vx run`'s env isolation dropped it, so NO run-time assertion can
      prove the `passThrough` wiring. Found by trying to write one and
      watching the local gate reject it: the gate sets
      `VX_REQUIRE_SANDBOX` and deliberately NOT the non-root one, so
      "wherever one is set the other is" is false there.
      Asserted statically instead, as the half the neighbouring law
      ("a suite that skips without an env var") was missing: that law
      proves a gate is SET by a workflow and says nothing about whether
      the value survives the trip. Every `VX_` var a workflow sets must
      appear in some task's `passThrough`, or the gate it arms is a
      no-op reporting green. Eight declared, eight forwarded today;
      differential by renaming one side.
482.  DONE (2026-09-20, `cli/watch.ts` — 1152 lines). The ignore class
      itself is exemplary and nothing is owed there: every member of
      `IGNORED_SEGMENTS` and `IGNORED_SUFFIXES` has its own row, on
      BOTH sides, with the controls that separate a segment rule from a
      substring one (`node_modules-shim.ts` is source) and an anchored
      suffix from a mid-name one (`a~b.ts` is source). That is what 479
      wished for.
      THE FIND is one directory down, in `POLL_SKIP` — the set the
      polling fallback never descends into. Its comment justifies the
      set: `makeWatchIgnore` "already drops their EVENTS, so the walk
      buys nothing". That is true of `node_modules`, `.git` and `.vx`,
      which ARE `IGNORED_SEGMENTS`. It is NOT true of the fourth name,
      `dist`, which is dropped only when a project DECLARES it as an
      output. A project that does not declare it had every edit under
      its `dist/` silently invisible to `vx watch` — on exactly the
      hosts the poller exists for (a macOS sandbox with no
      `machLookup` for FSEvents, a network mount, a container bind),
      while the native watcher delivered the same edit. Two watchers
      disagreeing about what an edit IS, and the disagreement is
      silence: no error, no cycle, the loop just sits there. A
      committed `dist/` consumed as an input is an ordinary JS
      monorepo shape.
      Read off a probe, not reasoned: the poller reported only
      `src/index.ts` while `isIgnoredWatchPath('dist/vendored.js')` is
      false, so the native watcher would have delivered it.
      Fixed at the seam rather than by deleting the name.
      `POLL_SKIP` is now `IGNORED_SEGMENTS` — the set its own comment
      describes — and `pollWatcher` takes a `skipDir` predicate the
      watch loop fills with its OWN `isIgnoredPath`. The poller then
      skips exactly what the event filter would drop anyway, per
      project: every declared output container, including the
      `build/out` and `gen` shapes the hard-coded name never covered,
      and `dist` when and only when a task declares it.
      Cost, measured (2000-file `dist`, min-of-7, interleaved A/B):
      2.84 ms per scan walking it against 0.25 ms skipping it — 2.6 ms
      once every 250 ms, ~1% of one core, and paid ONLY by a project
      that does not declare the directory. A declared `dist/**` costs
      exactly what it did.
      Pinned both halves in one row: an undeclared `dist` edit is
      reported, a declared one is not, with `src.ts` as the control
      that the second watcher was live at all. Differential both ways —
      `dist` back in the default set reddens it, and so does the whole
      pre-fix source.
      The gate then went red on FOUR watch e2e rows, which is the part
      worth keeping. Each asserted three executions under events and
      TWO under polling, explained by the edit and the task's own write
      landing in the same 250 ms sample — `deliveryMode` (item 418)
      existed to pick the arm. That explanation was a plausible cause
      nobody had measured, and it is wrong: the poller never sampled
      the write at all, because `dist` was skipped. With the skip gone
      all four settle at THREE with the labels the events arm asserts,
      so the mode branch is deleted, each row states one number, and
      `deliveryMode` is retired with the record of what it was for. The
      rows are stronger for it: they now assert that the two watchers
      agree, which is the guarantee, instead of encoding the way they
      differed.
483.  DONE (2026-09-20, `orchestrator/run.ts` and the unresolved-task
      rule it enforces). The rule — "a CI job that renames a task must
      go red, not silently stop running it" — has ONE producer
      (`unresolvedRequests`, graph/task-graph.ts) and THREE enforcement
      sites: the run path (run.ts:206), the plan builder (run.ts:932),
      and the CLI's `--dry`/`--graph` path (cli/run.ts:565). Mutating
      them separately is the whole method here, and the first attempt
      refused to run: the same guard text appears TWICE in run.ts, and
      a uniqueness assertion caught it before it mutated the wrong
      copy. Redone line-targeted.
      The four verdicts differ, which is the point. The producer fails
      EIGHT rows. The run path fails five. The plan builder fails one.
      The CLI's dry-run path fails NOTHING — the survival a
      whole-file mutation would have hidden behind the other three,
      and exactly the "suspect a second copy of the rule first" case.
      Why it survives: the guard directly below it
      (`plan.tasks.length === 0`) catches the same case and returns the
      same 1, because the plan builder hands back `{ tasks: [] }` for
      an unresolved ask. So the FAILING is held twice — 481's find-one
      one layer up — and what this site carries alone is WHICH names
      the message blames. Read off the real CLI, not reasoned:
      pristine: no projects declare task(s): typo-here.
      disabled: no projects declare task(s): build, lint, typo-here.
      Two perfectly good tasks named as the problem. On a long task
      list with one typo that is the difference between a pointed
      message and a useless one, and the run path pins this precision
      five times over while the dry-run path had nothing: the same
      user-facing rule held on one path and unheld on the other.
      Pinned in cli.test.ts with the control that carries it — each
      resolving name asserted ABSENT individually, because a
      `toContain` on the good line passes under the fallback's wording
      too. Differential: with the guard disabled the row receives the
      three-name message.
      Method note, recorded because it nearly went the other way. The
      gate came back with the NAMES yardstick identical and one new
      failing TASK — `shard-9`, exit 132, a Bun `panic(main thread):
Segmentation fault`, no failing row. Shard-9 does not hold
      `cli.test.ts`, the only test file this item touches, and the
      shard file lists are byte-identical with and without the diff;
      but the shard then crashed 2/2 on the changed tree and passed
      once pristine, which looked like proof of the opposite. It is
      not: no file in the shard crashes alone, and an INTERLEAVED A/B
      settles it — pristine 1/10 crashes, changed 3/11. Both sides
      crash, so it is a flaky runtime segfault in a 17-file
      single-process shard, and the 2/2 was the coincidence. One
      control sample is not a control; the repo already learned this
      as "two measured quantities sit on jitter" (item, 2026-09-16).
      Left unpinned and NOT added to the task baseline — it is Bun's
      crash, not a vx behaviour, and a baseline entry would hide a
      real shard-9 failure later. Noted under In flight instead.
484.  DONE (2026-09-20, `orchestrator/run.ts` — 1048 lines). A HELD
      report with one classified survivor, and the best-held file swept
      in this loop. Seven mutations, six caught, each by rows that NAME
      the claim rather than noticing it sideways.
      The `VX_TASK_TIMEOUT` rung carries four separate claims and each
      has its own row: removing the clamp fails "a value past the timer
      ceiling is CLAMPED, not passed through"; accepting 0 fails "0 and
      negatives are IGNORED — 0 never means 'no timeout'"; accepting a
      non-integer fails "non-integer and non-numeric junk is IGNORED";
      and putting the env rung ahead of the flag fails "RunOptions.
      timeout (`--timeout`) overrides the env default" AND a docs-drift
      row asserting every page states all four rungs. That is the
      four-source precedence chain 461 and 468's shape would predict
      trouble in, isolated correctly at every rung.
      The nested-`vx run` refusal fails two rows, including the
      TERMINATING shape (`ci` shelling out to `vx run lint`) that is
      easy to forget beside the unbounded-fork one.
      The teardown ORDER is held too, which is the one that surprised:
      "BEFORE teardownPlugins, and that order is load-bearing" —
      inverting it (plugins down before the upload drain) fails "a
      third-party layer declaring hasRemote gets the prefetch pass and
      the upload drain". An ordering constraint whose violation is
      SILENT (a plugin's client released under an in-flight upload,
      "losing every remote write with nothing but a warning") is
      exactly the kind that usually goes unasserted.
      Measured, because the clamp's comment made a platform claim
      nobody had checked — the rule that a platform unit is measured,
      never asserted. `setTimeout` at `MAX_TIMEOUT_MS` (2**31-1) waits
      properly; at MAX+1 Bun emits `TimeoutOverflowWarning: ... does
not fit into a 32-bit signed integer. Timeout duration was set to
1` and the timer fires at 3.8 ms. So "would mean 1 ms — killing
      every task instantly" is correct and the clamp sits exactly on
      that boundary.
      THE SURVIVOR is the sandbox reset — `if (sandboxArmer?.armed)
await resetSandbox()`, whose comment says "otherwise SRT keeps
      proxy servers alive and the next vx run would init on top of
      stale state". Skipping it leaves the repo green. It took two runs
      to say that honestly: the first reported ONE new failing row, a
      watch e2e row about a git checkout that has nothing to do with
      sandbox teardown. That row is red in 1 of 66 full-suite logs from
      this loop and the one time was that run, which reads as an
      association — and the re-run refutes it, with no new names at
      all. One run is not a verdict even when the base rate flatters it.
      Classified, not pinned: the guarantee is CROSS-RUN, about state
      surviving into the NEXT `vx run`, and a suite that runs one
      process cannot see it; the sandbox suites are `.unsafe` and
      excluded from the shards besides. The observable is a leaked
      `socat` bridge rather than a failing assertion — this container
      currently holds several, the oldest ~17 h. That is the same
      untestable-here shape as 477(a), with a concrete observable a
      future pin could use (count the bridges before and after a
      sandboxed run) if it is ever worth a `.unsafe` row.
485.  DONE (2026-09-20, `cache/archive.ts` — 659 lines, and the one
      place the repo calls "attacker-reachable" in as many words).
      `assertSafeName` is a SEVEN-clause shape class over every entry
      name at read time — 479's `SHELL_CONTROL` again, on a security
      boundary. Five clauses are pinned by name (absolute, `..` in
      three shapes, backslash, drive prefix, extended-length prefix)
      and the `//` clause turns out to be what two "absolute path"
      rows actually exercise. TWO had nothing, and both looked
      unreachable, which is why they had nothing: a ustar name field
      is NUL-terminated and cannot be empty.
      The door is pax. A pax `path` record is LENGTH-prefixed rather
      than NUL-terminated, and it OVERRIDES the header name — the
      suite already has a row for that override carrying a traversal.
      So both clauses are reachable, and the first probe proved the
      reader passes a NUL straight through: a pax
      `path=outputs/safe.txt\0../../evil` was refused by the `..`
      clause while the message printed the name truncated at the NUL.
      That is the second-path check 480 and 481 asked for, and it says
      reachable rather than dead.
      Isolated with payloads carrying ONE unsafe property each, both
      read off a probe:
      EMPTY NAME is the serious one. Pristine refuses it
      ("archive entry has an empty name"); with the clause removed the
      restore RESOLVES — no throw, no file, a green cache hit over an
      entry dropped on the floor. That is the same
      "restoring successfully leaves a hole nothing detects" hazard
      `restoreOutputs` names one file over, arriving through the
      container instead.
      NUL is the classification one. Removing the clause lets nothing
      through — the runtime's own path validation refuses it ("The
      argument 'path' must be a string, Uint8Array, or URL without
      null bytes") — so the SAFETY is held twice and what the clause
      carries alone is that the refusal is an `ArchiveSecurityError`
      rather than a raw TypeError. That distinction is load-bearing:
      `restoreOutputs` re-throws `ArchiveSecurityError` unchanged and
      turns anything else into a corrupt-artifact or an internal
      error, and a filesystem refusal surfacing as an internal error
      is a defect by this repo's own rule. 481 and 483's shape a third
      time, now on a security path.
      Both pinned through the pax door, the NUL row asserting the
      CLASS and not only that it threw. Differential per clause: each
      removal reddens its own row and leaves the other green.
486.  DONE (2026-09-20, finishing `assertSafeName` — the per-member
      question 485 left open). 485 pinned the two clauses that had
      nothing; this asks whether the other five are pinned SEPARATELY
      or whether one row covers several, which is the question 479
      turned on. Four line-targeted mutations, one per clause.
      Three are pinned exactly once each and by name: absolute fails
      "rejects an absolute name", backslash fails "rejects backslash
      separators", drive prefix fails "rejects a Windows drive-letter
      prefix". One row per clause, no overlap — the arrangement 479
      wished for.
      THE FIND is `..`, which has FOUR rows naming it and SURVIVES all
      of them. Every one asserts the same loose
      `/escape|traversal|unsafe/i`, and a traversal is refused TWICE:
      by this name check, and by the containment check that runs after
      the path is resolved against destDir. Read off a probe, same
      payload both ways:
      with the clause: archive entry name escapes via '..' (unsafe)
      without it: archive entry escapes destDir (unsafe)
      Same error class, nothing written either way — the safety really
      is held twice, so this is not a hole. What the name clause
      carries ALONE is precisely what its own comment claims for it:
      refusal "before anything decides where to write it". The
      containment check resolves first and answers second; deleting
      the early half of a defense-in-depth pair left four green rows.
      That is 481, 483 and 485's shape a FOURTH time — the failing
      held twice, the classification unasserted — and the fourth is
      the one that says the shape is the rule rather than the
      exception. When two layers refuse the same input, a row that
      asserts only THAT it refused pins neither.
      Pinned by tightening one `..` row to `/name escapes via/i`
      beside its existing loose assertion, so the row states both that
      the traversal is refused and WHICH layer refused it. The control
      is its three siblings: they keep the loose regex and still pass
      with the name clause removed, which is what proves the
      containment layer is independently alive rather than the pin
      having simply moved the goalposts.
487.  DONE (2026-09-20, `cache/zstd.ts` — the decompression ceiling,
      chosen BY the shape rather than by file size). 486 made the
      pattern a rule: when two layers refuse the same input and the
      rows assert only THAT it refused, neither is pinned. The four
      `ingest()` rows all assert `rejects.toThrow(CorruptArtifactError)`
      and the ceiling has three throw sites, so it was the obvious
      next place to look. It was there.
      Three mutations, one per site. The DECLARED half (the frame
      header's own claim, refused before a byte is allocated) fails
      "ingest() reads a 4-byte Frame_Content_Size (fcsFlag 2) and
      rejects an oversize declaration". The other two survive.
      The POST-DECOMPRESS re-check is UNREACHABLE, and proving that
      took a probe rather than an argument: forge a frame whose
      declared size is small and whose body is large, and Bun refuses
      it itself ("Decompression failed"). Since the declared half
      already refuses anything claiming more than the cap, a frame
      reaching the re-check declared <= cap and produced exactly that,
      so `out.length > cap` cannot hold. Its own docstring called it
      the ceiling applied "again on the actual length", which claims a
      second live layer the code does not have — de-claimed in place
      to say what it IS: a backstop against a decoder that stops
      validating the declaration. Kept, because that is worth keeping;
      just not counted as coverage.
      THE FIND is the STREAMING half — the running count over a
      sizeless frame, which is exactly the shape a streamed producer
      emits (vx's own, above 4 MiB) and exactly the one the module
      promises has "nowhere to expand". It works: at a lowered cap the
      probe gets "decompresses past 4096 bytes (cap)". It had nothing
      asserting it, and the reason is worth recording because it is
      not carelessness — the cap is 2 GiB, and the declared half is
      pinnable with a 20-byte forged header while the streaming half
      needs an artifact that actually expands past two gigabytes. The
      cheap half got a test and the expensive half got a comment.
      So `decodedTar` now takes the cap as a parameter, defaulting to
      the constant, for that row and nothing else: an internal module
      (not in the façade, imported by path nowhere in src), one
      optional argument, no behaviour change. The row drives a real
      sizeless frame past a 4 KiB cap and asserts the STREAMING
      message, with a control at a cap it fits proving the decode
      itself still works. Differential: removing the count reddens it
      and leaves the declared half's row green.
488.  DONE (2026-09-20, `ingest()`'s v17 invariant — the guard 487 left
      unmutated in the same function). Hunting the shape again, and
      this time it came with a leak.
      `if (scanned.stdout === null) throw` survives the whole suite.
      The row that LOOKS like its coverage is
      "ingest() rejects valid zstd that is not a vx artifact (no stdout
      entry)" — and its payload is `not a tar archive at all`, which
      fails in the TAR READER and never reaches the check. A row named
      for one guard, exercising another, which is how the miss stayed
      invisible: grep says covered.
      Probed with the shape an attacker actually sends — a real
      tar.zst, correct in every way the reader checks, minus the one
      entry that makes it ours:
      with the guard: CorruptArtifactError | missing stdout entry
      artifact on disk: false
      without it: Error | NOT NULL constraint failed:
      entries.stdout
      artifact on disk: TRUE
      So the REFUSAL is held twice again — the SQL column carries it —
      but this one is not only a classification. The guard runs BEFORE
      the rename, and the catch that cleans up unlinks `tmpPath`; once
      the rename has happened that name no longer points at the file
      that exists. Delete the guard and every such ingest leaves an
      ORPHAN artifact in the cache directory, refused but resident.
      The neighbouring rows assert `existsSync(...)` is false precisely
      because their payloads die earlier, so nothing covered it.
      Pinned with the well-formed-minus-stdout payload, asserting the
      class, the message AND the empty directory — that last one being
      the half no other row can reach. The old row keeps its payload
      (non-tar bytes are worth refusing) and is RENAMED to say what it
      tests, since its name was the thing doing the hiding.
      Fifth in the run 481, 483, 485, 486, 487 — and the first where
      the second layer, while genuinely refusing, leaves the system
      dirtier than the first would have.
489.  DONE (2026-09-20, `cache/layered-cache.ts`'s degrade paths and
      the two temp cleanups). A HELD report with one classified
      survivor, and it answers the question 488 raised rather than
      just repeating its method.
      The three degrade-to-miss paths are pinned by rows that name
      them: making a corrupt remote artifact throw instead of degrade
      fails "get() degrades a corrupt remote artifact to a miss
      instead of throwing"; accepting a malformed plugin result fails
      "get() that resolves the wrong shape is named as the plugin bug
      and degraded to a miss"; dropping the local-already-has
      short-circuit fails TWO rows, including the provenance one
      ("keeps source local when the pull skipped the remote") that
      exists so a warm-local hit is not mislabelled remote.
      488's new question was whether a second layer that refuses also
      CLEANS UP, since there it did not. Measured here rather than
      assumed: three corrupt-remote shapes — garbage bytes, a
      well-formed archive with no stdout entry, a truncated frame —
      each degrade to a miss and each leave the cache directory
      holding nothing but its own `.gitignore`. The degradation is
      tidy, which is the answer 488 could not give for its own guard.
      THE SURVIVOR is one of the two temp cleanups. `ingest`'s is
      pinned exactly, by "ingesting a large artifact cut mid-stream
      refuses it and leaves no temp file". The PACK path's — whose
      comment promises "the partial temp must not outlive the
      failure" — has nothing, and the reason is that its window is
      genuinely hard to reach: an output that vanishes or changes
      shape BETWEEN the plan's stat and its read. Probed three ways
      (delete late outputs mid-pack, delete after a separate plan
      pass, delete before the save at all) and it never fired; the
      last one is why, and it is worth recording: a missing output is
      refused at the PLAN stage with a UserError ("output dist/f2.bin
      is a dangling symlink") before a temp exists to leak.
      So the cleanup guards a real TOCTOU window that the plan-stage
      validation pre-empts for every case a test can construct.
      Recorded, not pinned, and deliberately WITHOUT the seam 487
      added: there the seam bought a live bomb defense its own module
      promised, here it would buy a cleanup for a window nothing
      reachable enters. A seam needs a reason proportional to what it
      exposes.
490.  DONE (2026-09-20, `workspace/config-schema.ts`'s timeout pairs —
      the double-refusal hunt moved OUT of the cache area, and this is
      where it stops paying). A HELD report, the second running, and
      the pattern's absence here is the useful part.
      `timeout` is validated by a literal pair in the same function: a
      positive-integer check, then `assertTimeoutInRange` — two
      refusals of the same field, both `UserError`, at BOTH the
      workspace and the `exec` level. That is 486's shape on paper.
      It is pinned on paper too. Four mutations, four caught, each by
      rows naming the half they cover rather than the fact of a
      throw. The shared RANGE half fails FIVE: two behavioural rows
      ("past the bound is refused, naming the max and the repair" and
      its at-the-bound control), the workspace-level twin, a
      docs-drift row asserting `docs/schema.md`'s table carries the
      exact symptom, and — the one worth naming — "a 317-year timeout
      fails the load instead of killing the task in 4ms", which is
      484's measured platform trap pinned END TO END rather than
      restated. The positive-integer halves fail their own rows at
      each level, and no row covers both halves.
      So the answer to "is the second refusal asserted separately" is
      yes, four times, which is what 486 wished for and 481/483/485/
      487/488 each lacked. Recorded because a hunt that only reports
      hits is a hunt whose negative result nobody can read.
      One thin spot, classified not fixed: `exec.command must be a
non-empty string` is caught by exactly ONE row, and it is the
      docs-drift table match. The claim that an empty command is
      refused therefore rests on a test about a MARKDOWN TABLE rather
      than about behaviour. It is covered — the mutation dies — so
      this is not a hole; but it is the only refusal in the file whose
      sole witness never runs a task, and if the table is ever
      reworded the claim loses its last row. Noted here so the next
      sweep of this file starts there.
491.  DONE (2026-09-20, `cache.ts`'s `prune`, picked by COST rather
      than by the double-refusal pattern — 489 and 490 had both come
      back held, which is the signal to stop pattern-matching).
      Prune's worst case is deleting something the user wanted kept,
      so the four claims swept were: `--dry-run` returns before the
      delete, the eviction order is LRU, the loop stops at the cap,
      and a prune with no criteria refuses. All four caught — dry-run
      by "prune({ dryRun }) reports the victims and orphans and
      deletes nothing", the empty options by their own row, and the
      other two by ONE row between them: "prune() with maxBytes evicts
      LRU until under the cap".
      That one row is the find. It asserts `evicted >= 1`, that h3
      (newest) survives and that h1 (oldest) is gone — and says
      NOTHING about h2, the middle of three. So it cannot tell
      "evicted exactly enough" from "evicted one too many". Removing
      the break wholesale is caught only because h3 dies too; an
      OFF-BY-ONE is not. Measured on the row's own fixture:
      correct: evicted=1, survivors=[h2, h3]
      off-by-one: evicted=2, survivors=[h3]
      `remaining < maxBytes` instead of `<=` survives the entire
      suite. Both outcomes leave h1 gone and h3 alive, which is all
      the row ever asked.
      Classified deliberately: this is NOT a stale hit — a pruned
      entry is a miss, and the run re-executes correctly. It is a
      silent efficiency regression, throwing away cache the user
      asked to keep on every prune, and hit rate is the thing the
      cache exists for. Worth pinning for that reason and no
      stronger one.
      Tightened in place: the count is exact (`toBe(1)`) and the
      MIDDLE entry is named as a survivor. Differential three ways —
      the off-by-one reddens it (receives 2), the wholesale break
      removal reddens it (receives 3), and reversing the LRU order
      still reddens it, so the row now separates the three failures
      it previously conflated into one.
      Method note: the row's endpoints looked like a complete
      statement (oldest gone, newest kept) and the gap was the
      unnamed middle. 479 and 486 found the same shape in a guard's
      members and a clause's siblings; this is it in a FIXTURE's
      rows, which is where it is hardest to see, because three
      entries read as exhaustive until you count the assertions.
      And the tightened row then FAILED the gate while passing alone,
      which was the fixture, not the code: the cap was
      `statSync(outputsPath('h3')).size * 2`, one artifact's size
      doubled, but the three artifacts are not the same size. Each
      carries its own duration and timestamps, so they compress to
      different lengths, and to different lengths run to run
      (198/193/193, then 199/193/190, over six reps). Whenever
      h2 > h3 the cap sits BELOW h2 + h3 and evicting h2 is correct —
      the very reading the row exists to exclude. The cap is now
      `size(h2) + size(h3)`, the exact budget the two survivors need,
      so "exactly enough" is the only way under it. Both differentials
      are red again on that fixture.
      The lesson generalizes past this row: a bound measured from ONE
      sample of a quantity that varies per entry is not the sum it
      stands in for, and a fixture that samples one member to bound
      three is a flake with a schedule. Sample what the bound must
      admit, member by member.

492.  DONE (2026-09-20, the zombie row in
      `tests/alive-helper.unsafe.test.ts` — #617's CI went red on it
      with a STATUS-only diff, and the row had been red once in 99
      local logs). Not a flake to re-run: the reported
      `{state: 'r'}` is `charAt` of the row's OWN `'() reaped'`
      sentinel, so the assertion was saying the zombie had been
      reaped before it could be observed, which is a racing fixture.
      The reaper is the row's own shell. `sleep 0 &` is already dead
      when bash runs the next line, and bash reaps a dead child at its
      next `waitpid` — so whether a zombie ever exists depends on
      whether SIGCHLD lands before the `exec`. Measured, 25 reps per
      shape: the current script plus a foreground command before the
      `exec` (a `waitpid` the shell must make) is reaped 25/25, while
      the same script with `sleep 0.5 &` is a zombie 25/25 — the
      child's LIFETIME is the whole difference, and the script with
      the longer-lived child survives the condition that breaks the
      other deterministically. The fix is one character class:
      `sleep 0.5 &`, so bash is replaced by a process that never waits
      while the child is still running. 12/12 green after, and the row
      still reddens when `isAlive` stops counting `Z` as dead, so it
      kept the guarantee it exists for.
      Method note: a red row on a docs-only diff is the most tempting
      "not mine" there is, and the temptation is exactly why the
      failing VALUE had to be read rather than the failing name. `'r'`
      named the sentinel, the sentinel named the race, and the race
      was in the test's own first line.
