# Shipped, 2026-09 — improvement-loop items 453–472

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
`2026-09-improvement-loop-433-452.md`; items 473 onward continue in
`docs/STATUS.md`.

453.  DONE (2026-09-20, the lead 450 left: the ONE-SHOT path's own
      placeholder sweeps, which 450 did not touch).
      REFUTED first, by reading before mutating: the two sites there do
      NOT carry 450's two-asker shape. They are mutually exclusive — the
      catch rethrows, so the success-path sweep below it is unreachable
      once the catch has run — and sequential callers cannot race.
      FOUND instead, on the exit that nothing drove: removing the sweep
      from the executor's catch breaks nothing in the repo. It matters
      because `sandboxRequestFor` creates the placeholder BEFORE the
      executor runs, and the request builder is shared, so a PLUGIN
      executor gets one too. When that executor rejects — a wire down,
      or a malformed result caught by `assertExecuteResult` — the sweep
      in the catch is the only thing that takes the file back. Left
      behind, it is precisely the trap the placeholder machinery exists
      to prevent: the task's own `mkdir` says "File exists" on every
      later run, and an output glob's clean matches nothing under a
      file, so it never clears by itself.
      Unpinned because the combination is narrow — a plugin executor
      AND a sandboxed task with a literal write grant — which is the
      arc's recurring shape stated once more: the gap is not in the
      hard code, it is where two ordinary features meet.
      Pinned with a workspace plugin whose `executor` throws, over a
      task granting `write: ['out.txt']`, asserting the run fails with
      the plugin's message and the project holds no `out.txt`. Red 3 of
      3 under the mutation, green with the fix.
      MAIN's red of 05d428a, recorded as CLOSED-UNEXPLAINED. That push
      run failed one task of 44 in the Linux job while the identical
      tree was green on its own PR run. The failing task's NAME was
      never obtained: the log tail did not reach its block and the
      signed blob URL is refused by this container's egress proxy. It
      has not recurred — main's push run for 9db1f99 is green — and the
      cause is UNKNOWN. 450's placeholder race fits the shape and is
      not offered as the answer; a guess written down becomes a fact
      nobody re-checks.

454.  DONE (2026-09-20, and it is a ZERO-YIELD report, the second of the
      arc after 427 — the staged config load EVERY reader shares,
      `config-eval.ts` beside `projects.ts`, which
      Next 8(c) flags and which I picked as the highest claim density
      left). Four claims mutated one at a time. All four CAUGHT, and
      the map of what pins what is the deliverable, so nobody re-sweeps
      here.
      (a) "Load in rounds to a fixpoint" for a `pkg#task` edge the
      package graph cannot reach. Capping it at one round fails three
      rows, one of them named "follows a cross dep discovered in a
      LATER round".
      (b) The `staged` reuse — a project the CLI's selection pass
      already loaded is taken as is, so the `project` stage's cost AND
      its warnings land once per run. Ignoring `staged` entirely fails
      two rows under a describe named "the project stage runs once per
      project per run".
      (c) `clearTimeout` in `evaluateConfigFresh`'s `finally` rather
      than after the await — the orphan timer that used to fire later
      and kill an unrelated healthy round. Moving it fails SIX rows,
      one named "a REJECTED evaluation does not poison a later one".
      (d) The `project`-stage gate on which packages are visible at all
      ("with no `project` plugin a plain run never visits a config-less
      package"). Making them always visible fails the two `vx init`
      rows that pin what an empty workspace is told.
      Worth saying plainly, because it is the opposite of the last four
      items: a file whose comments tell a detailed story is NOT
      evidence either way — 447 and 450 both had one and were unpinned.
      What separates this pair is that each story has a row whose NAME
      is the claim. That is the shape to copy, and it is why this sweep
      cost four runs and produced no test: there was nothing missing.

455.  DONE (2026-09-20, the gap 451 left in MY OWN code: `attributesAbove`
      had no worktree fixture). Probed git rather than reasoned about
      it, which is 451(a)'s lesson, and the probe changed the answer
      twice.
      TWO real defects, both in where the clean-filter gate LOOKS.
      (a) `--git-dir` in a linked worktree names the per-worktree
      directory under the main repo's `.git`, which is not an ancestor
      of the worktree's files at all — so the walk that was meant to
      stop at the repo root never stopped and ran to the filesystem
      root, stat-ing for a `.gitattributes` in every directory above
      the repo and taking a stray one outside it as a reason to spawn
      `check-attr`.
      (b) The older half: `info/attributes` was looked up under that
      same per-worktree directory. Probed, with the negative case read
      FIRST: from inside a worktree `git check-attr text` answers
      `unspecified` with nothing set and `auto` once the rule is
      written to the COMMON dir's `info/attributes`, and the
      per-worktree gitdir has no such file at all. The gate was looking
      where the rule can never be.
      HONEST LIMIT, and the reason this ships without an end-to-end
      row. The stale hit (b) should cause does NOT reproduce: in a
      worktree `git status` reports the CRLF file modified, so vx drops
      the OID for a dirty path and is correct — by a route that is not
      the gate. The same repo's MAIN checkout, with identical
      `ls-files --eol` output, reports the same file clean. I did not
      establish why git differs there and have written no cause down.
      Masked is not fixed: the lookup is demonstrably in the wrong
      place, and the masking is one git version's behaviour.
      Fixed both: `--git-common-dir` replaces `--git-dir` in the
      existing rev-parse (same spawn, no new cost), and the walk's stop
      point comes from `--show-prefix`, which vx already has. Pinned
      the half that IS differential — `repoRootOf` against git's own
      `--show-toplevel` across four layouts (plain repo, subdir
      workspace, worktree, subdir-in-worktree), plus the assertion that
      the git DIRECTORY is not an ancestor there, which is the whole
      reason the derivation changed. Red under a mutation that returns
      the workspace root.
      The gate caught what running the file alone could not, and the
      lesson generalises. The new row COMMITS, and this file's local
      `git` helper did not disable signing — one older row remembered
      the flag inline and the next did not. This repo's environment
      configures an ssh signing helper that talks to a local MCP
      server, and a SANDBOXED shard cannot reach it: the file passed
      alone (unsandboxed, helper reachable) and failed in the shard.
      The helper owns the flag now, so the next row cannot forget it.
      A fixture that commits is a fixture that needs the sandbox's
      permission, and running it alone does not test that.

456.  DONE (2026-09-20, the pair CLAUDE.md names stale-hit-critical in
      its own words: `hit-restore.ts` against `miss-save.ts` — what a
      hit restores against what a miss saved). Three claims mutated one
      at a time. Two CAUGHT, one SURVIVED and is recorded as COST after
      a probe refuted my correctness theory for it.
      (a) The skip-restore short-circuit requires BOTH that the output
      walk yields exactly the expected set AND that every file's
      fingerprint matches. Mutating the DIRECTORY short-circuit to
      trust its recorded set unconditionally — a perf gate deciding
      whether the integrity walk runs at all, which is the shape that
      found 451's stale hit — fails two rows, one named "an added stray
      still forces the restore".
      (b) The other half of that BOTH: dropping the per-file
      fingerprint check fails four rows, including 451's own new row.
      (c) SURVIVED: `markWorkspaceOutputsChanged`, which marks a
      workspace output's exact paths against every partition that can
      see them, including a project partition whose dir contains the
      path — the no-boundary escape hatch. Dropping it breaks nothing.
      My theory was a cross-project stale hit, and the probe REFUTED
      it. Built the fixture on the real CLI: `a#gen` writes into `b`'s
      directory through `outputs.workspaceFiles`, `b#build` reads it.
      Correct with the fix and correct WITHOUT it, because architecture
      principle 5 does the work — `b` folds `a`'s INPUT key, so `b`'s
      key moves whether or not the snapshot was marked. The only shape
      the marking could decide is a reader that does not declare the
      dependency, and that is undeclared ordering, outside the
      contract.
      So it is cost and defence-in-depth, not correctness, and it is
      deliberately left UNPINNED for 447's reason: a test would have to
      count git spawns, pinning the implementation rather than a
      guarantee. Recorded here so it is not rediscovered as a find.

457.  DONE (2026-09-20, the sandbox bind pair — `exec/sandbox-binds.ts`
      against `orchestrator/sandbox-request.ts`. 428 took the read side
      and 433 the derive side; `punchWritePaths` itself had never been
      mutated one claim at a time, and it is a security boundary, so a
      survivor there is worth more than elsewhere). Two claims.
      (a) CAUGHT: "recursing only along the branches that actually
      contain one". Flattening the recursion to a single level fails a
      row named, exactly, "recurses only along the branch that contains
      a write path". The punch's SHAPE is well held.
      (b) SURVIVED, and it is the find: the symlink warning. Silencing
      it breaks nothing. It is the one diagnostic for a failure with no
      other symptom — bwrap resolves a bind SOURCE, so punching a
      directory mounts each symlinked child as the directory it points
      AT, the link is gone inside the sandbox, and a package resolved
      through it loses the siblings its dependencies need. That cost
      FOUR DAYS of red CI (astro and `yargs-parser`, 2026-09-09), and
      SRT's config carries no `--symlink`, so the warning is not
      commentary on the fix — it IS the fix, because it says which
      grant to move.
      The shape is the arc's third diagnostic gap after 444 and 450: a
      message that exists precisely because the failure is otherwise
      inexplicable, held by nothing. Worth stating as a rule — when a
      comment says a message is the only signal for a class of failure,
      that message needs a row more than the code around it does.
      Pinned in the describe that already owns the function: a symlinked
      child plus a write grant, stderr captured, asserting the notice
      names BOTH halves (what was flattened and which grant to move)
      and appears exactly ONCE across two punches of the same grant, so
      a thousand-task run says it once. Red 3 of 3 under the mutation.

458.  DONE (2026-09-20, and it is a QUERY rather than a file: 444, 450
      and 457 were all the same shape — a message that exists because
      the failure is otherwise inexplicable, held by nothing — so ask
      it of the whole repo at once). Enumerated every diagnostic in
      `src/`, then checked which have a row asserting their text.
      TWO CORRECTIONS TO MY OWN METHOD, both caught by the differential
      rather than by care, and both worth more than the item's finds.
      First: the batch "survival" run was INVALID. My silencing inserted
      a marker at the template literal's OPENING backtick, which
      prefixes the message and leaves the distinctive phrase intact —
      so a row asserting that phrase would still pass, and the green
      run proved nothing. Caught only because the rows I then wrote
      passed under the same "silencing", which is the differential
      doing its job. Redone by replacing the PHRASE itself.
      Second: the coverage table was wrong. `teardown timed out after`
      read as zero-coverage and is in fact pinned by a row named "a
      teardown that never settles is named, not silently dropped" — it
      asserts a different substring. That is item 429's lesson exactly:
      grep proves absence only where you grep. One candidate removed
      from the list before any work was done on it.
      The properly-established survivors: the nameless-package skip,
      the scheduler's `onStart`/`onFinish` observer isolation, the
      sandbox cleanup failure, and the `--summarize` / `--profile`
      write failures. All silenced together, whole repo green.
      PINNED the three where the message is the only trace of something
      the user asked for. A nameless manifest WITH a vx config vanishes
      (vx identifies projects by name), and the existing neighbour row
      covers only the silent half — the config-less one — so the new
      row asserts the notice names the directory AND stays silent for
      the config-less sibling, which is the distinction the warning
      exists to draw. `--summarize` and `--profile` are asked for
      explicitly: the new rows point each at a path whose parent is a
      FILE, and require the run to stay GREEN (the tasks did their
      work) while naming the artifact it could not write. All three red
      with their phrase removed.
      LEFT UNPINNED and recorded: the observer-isolation and
      sandbox-cleanup notices. Both are real gaps of the same class;
      they are named here so the next session can take them without
      re-running the query.

459.  DONE (2026-09-20, taking 458's two named survivors — no re-query
      needed, the corrected silencing run had already established them).
      THE FIND IS BIGGER THAN 458 RECORDED. 458 said the scheduler's
      observer NOTICE was unpinned. Mutating further shows the
      BEHAVIOUR was unpinned too: deleting the try/catch around
      `onStart` — so a throwing observer escapes into the dispatch loop
      — is caught by nothing in the repo except the row written here.
      That matters because the scheduler holds the worker slot across
      the hook, so an escaping throw strands the tick with the slot
      held and the run never finishes. An observer is someone else's
      code (a reporter, an embedder's progress bar, the MCP server),
      which is exactly why it is wrapped.
      Pinned as one row per side: a throwing `onStart` and a throwing
      `onFinish`, asserting the graph still completes AND the notice
      names the task and carries the observer's own message. Red both
      ways — with the phrase removed (the notice half) and with the
      catch removed (the behaviour half).
      MY OWN HYPOTHESIS REFUTED, recorded so it is not re-raised: I
      expected CLAUDE.md's live invariant "Observability never breaks a
      run" to be overclaiming, since its stated proof is the telemetry
      suite. It is not. The line says SINKS are crash-isolated, and
      sinks are proven where it says they are; the scheduler's
      observers are a different seam that the invariant never claimed.
      The invariant stands as written — the gap was beside it, not in
      it.
      STILL UNPINNED, with the reason: `sandbox cleanup failed`. It
      needs `resetSandbox()` to throw, and there is no seam that makes
      it throw from a test — only mocking the ESM binding would, which
      pins the mock rather than the guarantee. Left as 456(c) was left,
      named rather than forced.

460.  DONE (2026-09-20, `graph/scheduler.ts` PROPER — 459 only touched
      its observer hooks, and this is the file that decides what runs
      when, the largest unswept claim cluster left). Four claims. Three
      CAUGHT, one survivor established as DEFENSIVE, not a defect.
      (a) `aborted` propagates like a failure. Dropping it from the
      propagation test fails two rows, one named "does not let its
      dependents cache what they built from its partial outputs" —
      which is the whole reason the status exists: the upstream died
      mid-write, so a dependent that ran anyway would cache partial
      bytes under the key a healthy run derives.
      (b) The reverse-dependency priority. Flattening every task to the
      same priority fails "prefers the task that blocks the most
      downstream work".
      (c) The O(1) per-lane admission gate, whose comment carries a
      measured number: the 6,000-task scale pin went 0.5 s to 28 s when
      a first cut let the scan run past a full exec lane. Removing the
      gate fails exactly that pin, by name. Worth saying because the
      arc has twice found a PERF gate quietly deciding correctness
      (451(c), and the shape again in 456(a)) — here the perf guard
      genuinely guards.
      (d) SURVIVED: `willSkip`'s restore-tier bypass, the line that
      stops a confirmed stable-key hit from skipping when an upstream
      fails. Removing it breaks nothing, and the fixture says why
      rather than leaving it a guess. Built it on the real CLI — an
      uncacheable upstream flipped to failing by a git-ignored file
      that moves no key, a downstream that is a stable local hit — and
      the outcome is "1 failed · 1 success" WITH the bypass and
      WITHOUT it, at default concurrency and again at `--concurrency 1`
      with a slow-failing upstream. The reason is structural: the
      restore lane is separate, so a restore-tier task is dispatched on
      the FIRST tick, before any dependency can fail, and `willSkip`
      sees no upstream outcome at all. The line is defensive and
      currently unreachable.
      Left unpinned deliberately, as 456(c) and 459's cleanup notice
      were: pinning it would mean pinning the lane ordering that makes
      it unreachable, which is the implementation rather than the
      guarantee. Recorded here with the reason so it is neither
      rediscovered as a find nor deleted as dead code — if the lanes
      ever merge, this line starts deciding something.

461.  DONE (2026-09-20, `cli/select.ts` — never swept, and it decides
      the SET a run operates on). The find is real, but the METHOD
      LESSON is the headline and it applies to everything this arc has
      done.
      LAYERED GUARDS ARE INVISIBLE TO A ONE-AT-A-TIME SWEEP. A
      `--frozen` run with no lock is refused in TWO places: the staged
      load every verb goes through (`loadCliProjects`), and again in
      `workspaceGlobOwners` before its tolerant sweep could answer
      "nothing affected". Remove either ALONE and the whole repo stays
      green — because the other one covers. So the sweep I have been
      running all arc reports "pinned" when in fact NOTHING pins it.
      Established by removing BOTH and running the real CLI: a lockless
      workspace, `--frozen --affected` with an orphan-only change, and
      vx exits 0 saying "nothing affected". That is the worst answer a
      CI tool can give — green, ran nothing, said nothing — and it is
      what the two guards exist to prevent.
      Each guard then re-checked on its own to confirm it is a genuine
      backstop, not decoration: with the outer one removed the inner
      refuses (exit 1); with the inner removed the outer refuses.
      Neither was pinned by any test.
      Pinned as one row EACH, deliberately, so they cannot hide each
      other's absence again: the inner one through `workspaceGlobOwners`
      directly, the outer through `loadCliProjects`. Both carry a
      control (the same call without `frozen` answers normally, so the
      rejection is the flag and not a broken fixture), and each is red
      for its OWN guard and green for the other's.
      Carry this forward: when a guarantee is enforced in more than one
      place, a single mutation proves nothing. Mutate the whole set, or
      pin each layer separately. Four earlier "survived but not a
      defect" results (447, 456(c), 459, 460(d)) were each argued from
      a single mutation — three of them were established further with a
      fixture, but the reasoning pattern is the one this item just
      caught being wrong.

462.  DONE (2026-09-20, acting on 461's method lesson rather than on
      claim density: if a one-at-a-time sweep is blind to layered
      guards, go find the other layers).
      THE SAME GUARANTEE HAS THREE SITES, not two. 461 pinned the
      staged load and selection; `prepare.ts` refuses the same thing a
      third time, and removing THAT one alone also leaves the whole
      repo green. So all three were unpinned while an e2e row named "a
      frozen run with no lock is refused by selection" passed happily —
      it drives the real CLI, so ANY surviving layer satisfies it. That
      row is exactly the false confidence the lesson describes.
      The third layer is not redundant. `prepare` is what an EMBEDDER
      reaches: `run({ frozen: true })` through the façade never touches
      the two CLI layers, so without it the run proceeds with a null
      lock and evaluates configs LIVE — under a flag whose entire
      meaning is "read them from the lock". Pinned through the
      programmatic entry with a control (the same call without `frozen`
      succeeds), red with that guard removed and green with it.
      THE SEARCH, recorded because the negative result is the useful
      part: this is the repo's ONLY layered guarantee of that shape.
      `FROZEN_WITHOUT_LOCK` is the one shared error constant with more
      than one throw site (three); the only duplicated refusal TEXT is
      four different field validations inside `config-schema.ts`, which
      are separate rules rather than redundant layers of one; and the
      boundary law's two enforcements (glob resolution and the sandbox)
      are different guarantees at different levels, not layers — a
      mutation of one is not covered by the other. So the blind spot
      461 found has now been swept to its edge rather than left as a
      standing worry.

463.  DONE (2026-09-20, `workspace/affected.ts` beyond what 445 fixed —
      and 461's layered blindness turned up again, this time on a
      SECURITY boundary).
      `--affected`'s base is guarded TWICE, deliberately and in
      writing: a pre-spawn check that refuses an option-like `since`
      (`--output=<path>` is a real `git diff` option and an arbitrary
      file write), and `--end-of-options` on every git call "so a
      second caller cannot lose the guard by accident".
      LAYER 1 is well pinned: removing the check fails four rows, each
      naming a concrete attack value (`-`, `--`, `--output=OUT`,
      `--upload-pack=OUT`).
      LAYER 2 had NOTHING. Removing all five `--end-of-options`
      occurrences leaves the whole repo green.
      Classified before acting, as 460(d) taught: its behaviour is not
      observable today, because every guarded helper (`verifyRef`,
      `mergeBase`, the diff) is reached only with the already-checked
      `since`, and `defaultAffectedBase`'s answer flows in through that
      same check. So the layer is exactly what its comment says —
      insurance against the future second caller — and deleting it
      would be wrong even though no behaviour test can catch it.
      That makes it a LAW rather than a behaviour, which is a genre
      this repo already has (`module-boundaries`, the doc pins). Pinned
      as one: every git argument array in the module that passes a
      VALUE (a template interpolation or a bare identifier) must carry
      `--end-of-options`; all-literal arrays need no guard, and a pure
      spread forwards a caller-built array that is itself checked. The
      row asserts the regex still matches at least four arrays, so it
      cannot go vacuous by silently matching nothing. Red with the five
      occurrences stripped, green with them.
      The distinction worth keeping: 460(d) was defensive AND left
      unpinned because pinning it would have pinned the lane ordering
      that makes it unreachable — the implementation. Here the layer IS
      the guarantee ("every call ends its options"), so a law states it
      without pinning anything incidental.
464.  DONE (2026-09-20, `orchestrator/admission.ts` — the seam between
      the scheduler and executeTask, never swept; 434 took its
      `taintTracker` and stopped there).
      Eight mutations, one control. Three claims are well held, each
      turning both dedup rows red: the joiner that drops its stale
      up-front probe (the control), the barrier that lifts only once
      the deferred SAVE has landed, and the deliberate `return await`
      that keeps the `finally` behind the task rather than behind its
      promise.
      THE FIND: the restore-tier bypass. A confirmed local hit runs
      BEFORE its dependencies, so the `upstream` array it is handed
      holds a HOLE where a dep's outcome will go, and the dedup path
      would recompute the task's hash from that array. Remove the
      bypass and the upstream fold reads that `undefined`: the run
      dies with an internal error instead of restoring bytes it
      already has. The whole repo stayed green without it. Both dedup
      rows run COLD, so nothing is ever in the restore tier, and every
      restore-tier row runs with no registry — the intersection of the
      two halves had no test anywhere.
      Pinned with the fixture that reaches it: two projects, so an
      edit to `lib` evicts `lib#build` alone while `app#build` stays
      stable and warm (it folds no upstream key), leaving it
      restore-tier with its dependency still running; then two
      concurrent runs share a registry. Both restore. Red without the
      bypass, green with it, and the three older rows pass both ways.
      Left unpinned, measured and classified:
      (a) the `canWrite` half of the dedup gate is a COST claim. Drop
      it and the joiner waits for a sibling that will never save, then
      executes anyway — correct, just slower.
      (b) the persistent and group conjuncts are redundant with the
      SCHEMA, which refuses `cache` on a persistent task and on a task
      with no `exec` (pinned in `project-loader.test.ts`) and is
      re-run after EVERY `project`-stage plugin (pinned in
      `plugin-pipeline.test.ts`). No path reaches admission with such
      a node, so there is no behaviour to pin.
      (c) the join's `.catch` on the barrier swallows a rejection core
      never produces: the barrier promise is built here and only ever
      resolved. What it actually guards is the embedder-supplied Map,
      which is a real boundary.
465.  DONE (2026-09-20, `orchestrator/logger.ts` — 700 lines, never
      swept, and it decides what a user is TOLD a run did).
      Nine mutations. Seven caught, and the well-held ones are held
      hard: `full` joining the discard set fails twenty rows,
      `focused` eleven, `broad` three; the per-run GHA fence token
      three (one named for the property itself); the live-framing gate
      six; and registering a persistent task's tail at ready instead
      of at its first chunk — the defect the comment documents — one.
      THE FIND is a SET asserted at one position. The comment at the
      discard gate states a deliberate partition: `none` and
      `hash-only` drop chunks on arrival because their contract
      promises never to print them, while `full`, `broad`, `focused`
      and `errors-only` print, and "silently truncating someone's
      build log is a worse failure than the memory it costs". Adding
      `errors-only` to the discard set leaves the WHOLE REPO green.
      Taken to the real CLI before being called anything, as 461
      taught: `vx run boom --output-logs errors-only` normally prints
      the STDOUT and STDERR sections, and under the mutation the
      failure frame comes out EMPTY — `failed (exit 3)` and nothing
      about why, from the one mode whose entire purpose is showing a
      failed task's log.
      The cause is an under-asserting row, and it is this repo's own
      rule failing in the other direction: the row named
      "errors-only: success and hits silent, failures framed" writes
      to stderr and then asserts only that the ONE-LINER is present,
      which the mutation leaves untouched. "Assert the exact expected
      set, not the absence of one string" — a substring that survives
      the change is no better than a `not.toContain`. Fixed in place
      to assert the frame's content, in the style of the `broad`
      failure row beside it.
      The second survivor is the same boundary's other half:
      `hash-only` LEAVING the discard set. No behaviour row can see
      it, because the mode prints one audit line per task and no log
      bytes either way — it is a pure memory claim, and the RSS
      measurement that pins `none` asserted only that one position.
      Extended to cover both, which is what the comment always said.
      Each pin red only for its own mutation, green for the other's,
      and the RSS row stable over three reps.
466.  DONE (2026-09-20, `orchestrator/framed-output.ts` — 530 lines,
      11 exports, 20 rows; the last large unswept file in the
      orchestrator).
      Six mutations. Two caught: an uncacheable task reading as a
      cache MISS rather than `no-cache` (three rows), and the sandbox
      violation list losing its de-duplication (one row, named for
      it).
      THE FIND is the frame footer's duration, and the file's own
      comment says why it matters: the duration is always what THIS
      run spent, and a comment that once claimed the opposite led
      `--report` to sum these as "time saved". Rendering
      `storedDurationMs` instead survives the WHOLE suite. On the real
      CLI a one-second task restored in 9 ms then prints
      `(1.00s) restored-local` — a cache hit reporting the work it
      avoided as work it did.
      Reachability was checked before the survival was believed, and
      the first reading was wrong: in the fast-filter files NO fixture
      sets `storedDurationMs`, so the mutation is a no-op there and
      proves nothing. The whole-suite run is what makes the survivor
      real, and the e2e probe is what makes it a defect.
      Pinned by making an existing fixture honest rather than adding a
      row: the restored-hit frame already asserts its exact text, and
      every real restore carries a stored duration (`hit-restore.ts`
      sets it from the entry), so the fixture now carries one too. The
      `toBe` that was already there does the work.
      SECOND FIND, a law: the module states that identity hues sit
      outside the status palette "so a task id can never read as an
      outcome", and that the task hue is excluded from the project
      palette. Painting the task hue green, or a project hue red,
      leaves the whole repo green — every rendering row runs with
      colours OFF. Pinned as a law over the constants, not a rendered
      escape sequence, because the guarantee IS the disjointness while
      the hue values are free to change; both rows carry non-vacuity
      guards and each is red for its own collision.
467.  DONE (2026-09-20, `orchestrator/upstream.ts` — 162 lines, chosen
      by claim density now that the large files are swept; it is the
      fold every cache key depends on).
      Six mutations, and the honest headline is that this module is
      ALREADY WELL HELD — the best-covered file the loop has swept.
      Its 19 rows earn their keep: matching a pattern name LITERALLY
      (the stale-hit trap its own comment names, where a filter
      silently selects zero upstream and decouples the task) fails
      seven rows; dropping negation fails five; an empty filter
      contributing everything instead of nothing fails four, one of
      them e2e; losing the first-id-wins dedup fails the row named for
      it.
      ONE survivor: the `!u.hash` skip. `TaskOutcome.hash` is
      optional and core does build outcomes without one — the
      scheduler's skipped / aborted branch omits it — so the fold
      would put `undefined` where an upstream's identity belongs.
      Reachability was MEASURED rather than argued, and the first
      probe was worthless: instrumenting the guard and running the
      gate wrote nothing, because a sandboxed task cannot write to the
      scratchpad. A negative case needs a positive control, and with
      one the unsandboxed probe logged 134 upstream entries across the
      continue-taint, abort, restore-tier and e2e orchestrator suites
      and NOT ONE without a hash. A dependent of a skipped task is
      itself skipped rather than keyed, so the guard is defensive
      today.
      Pinned anyway, and the genre matters: at the FUNCTION's own
      boundary, where "an upstream with no hash contributes nothing"
      is a statable contract over an input the type already permits —
      not by asserting that nothing upstream can reach it, which would
      pin the reachability, i.e. the implementation (the 463 line).
      One row covers BOTH folds (filtered and unfiltered) and carries
      a control; red for either guard removed.
      Recorded, not actioned: `filterUpstreamHashes` still does not
      guard `u !== undefined`, while `taintTracker` beside it does.
      464 established what keeps holes away from it — the restore-tier
      bypass — and that is now pinned, so the asymmetry is covered by
      that row rather than by a second one here.
468.  DONE (2026-09-20, `orchestrator/stable-keys.ts` — the gate that
      decides which keys may be probed and RESTORED ahead of the
      schedule, so a wrong "stable" is a stale-hit vector by
      construction).
      Eight mutations, six caught, several by rows named for the very
      stale hit they describe: a same-project producer no longer
      making the key preliminary fails six (one an e2e stale-hit row);
      the workspace-output clause, whose comment records a real stale
      hit, fails six; unstable tasks getting stable keys fails eight;
      the conservative default when the dirs are unknown fails two.
      THE FIND is a THIRD carrier, and the file's own header names the
      other two: 426 pinned the producer-set fold after both
      accumulators survived the whole suite, and the unit rows pin the
      gate. Nothing drove the `unstable` FLAG that travels along an
      edge. Removing it left the whole repo green, and removing the
      GROUP's member check did too.
      Why the fold hides it, which is 461's lesson a third time: where
      the dependent shares a project with the producer, the producer
      set reaches the same verdict, so the flag never has to. The
      arrangement that isolates it INVERTS the fold's rows — producer
      and unstable reader in the SAME project (so the reader is caught
      by the gate), dependent in ANOTHER project reading only its own
      dir, which the gate's own documented answer calls STABLE. The
      flag is then the only carrier, and it has to carry: the
      dependent folds a key that is PRELIMINARY until the producer has
      run.
      Two rows, deliberately separate so they cannot hide each other:
      the edge case and the same thing across a GROUP. Dropping the
      edge inheritance reddens both; dropping the group's member check
      reddens only the second. Both carry the same two controls — the
      unstable task is unstable by the GATE rather than by inheritance,
      and the producer keeps its own short-circuit, so the fixture is
      not just classing everything unstable.
469.  DONE (2026-09-20, `orchestrator/download-policy.ts` — which
      tasks may leave their outputs in the remote store). A WELL-HELD
      report with one classified survivor: no new test, and the
      measurement is the artifact.
      Eight mutations, seven caught, each by a row named for the claim
      it breaks: a runtime-command reader no longer forcing eager
      (two rows), a `workspaceFiles` reader, workspace-anchored
      OUTPUTS, a leading wildcard reaching everything, the overlap
      test losing its ancestor relation ("the OVERLAP is a path
      question, not a spelling one"), a surfaced task under `toplevel`,
      and a locally-placed task deferring. 28 rows over 171 lines, and
      they bite.
      THE SURVIVOR is one of three conservative fallbacks the module's
      own comment lists — "a cacheable task with no declared `files`
      is treated as reading its whole project". The other two are
      pinned; this one is not. Same shape as 465's partition, so the
      first question was whether it is reachable at all.
      It is, and it protects nothing. `cache.inputs.files` is REQUIRED
      by the schema, so the `undefined` half cannot arise from a
      config; the empty-array half can, and `files: []` means exactly
      what it says. Measured on the real CLI: a task with
      `cache.inputs.files: []` keyed `8e44f167` before AND after a
      project file changed — its key does not move with any file in
      its project, so whether a producer's bytes arrived cannot move
      it either.
      So this is a COST claim, not a correctness one (the 464
      `canWrite` genre): the `['.']` fallback makes such a reader
      block deferral of every producer in its project while guarding
      no key. Left unpinned deliberately — pinning it would pin the
      conservatism itself, and a later change that let those producers
      defer would be an improvement this repo should not have to argue
      with a test about.
470.  DONE (2026-09-20, `orchestrator/deferred-outputs.ts` — the
      registry of tasks whose outputs were left in the remote store,
      and the lazy fetch that brings them home).
      A CORRECTION FIRST, because the reasoning was wrong before the
      measurement was right. The module has no test file of its own
      and its name appears only in the module-shape drift check, and
      the only `--download=none` e2e rows I could find sat in
      `@vzn/vx-reapi` behind `describe.if(armed)` — unset locally, so
      skipped, and a skip is a silent pass. That reads like a total
      coverage hole and it is NOT one: gutting five invariants at once
      turned three CORE rows red. They drive the class through a real
      `run()` rather than naming it, which is why grep missed them.
      The gutting run is what corrected me, one run instead of eight.
      Six mutations then, four caught: `pending()` hiding what is
      inflight (the bug its own comment records), the at-most-once
      memo, dropping the entry before the fetch succeeded, and the
      convergence save.
      TWO SURVIVORS, both documented, both correctness.
      (a) The TRANSITIVE walk. Every existing row puts the deferred
      producer ONE hop from the consumer, where a direct-deps-only
      walk finds it anyway. Isolating it took two tries: an ordinary
      task in the middle proves nothing, because it runs locally and
      its OWN direct-dep materialisation fetches the producer whatever
      the walk does — measured, `mat` identical both ways. A GROUP
      intermediate is the isolation: it never executes, so it can
      never materialise, and with the recursion cut nothing is fetched
      at all and the consumer fails.
      (b) The fetch failure is the CONSUMER's failure. The row that
      looks like it covers this asserts `r.ok === false`, and that
      holds either way — with the error swallowed the run still fails,
      because the consumer's `cat` then hits a missing file. A second,
      incidental failure was masking the first. What separates them is
      the diagnostic, so that is what is pinned now: the message names
      the producer, the underlying cause, and the remedy, instead of a
      bare `No such file` from a shell.
471.  DONE (2026-09-20, `orchestrator/hit-restore.ts` — the restore
      path itself, whose own header calls it stale-hit-critical). The
      worst result of the arc: on the file that decides whether a hit
      may skip writing bytes, SIX of eight mutations survived, and two
      of them are real stale hits reproduced on the CLI.
      The short-circuit's contract is a conjunction — the tree is
      "already current" only if the output-glob walk yields EXACTLY
      the expected paths AND every file's fingerprint matches. The
      halves catch DIFFERENT divergences, and the suite held only one
      of them.
      (a) THE SET CHECK. Remove it and a MISSING output is still
      caught (by the fingerprint check), so the repo stays green —
      while a STRAY file survives. Measured: with a stray in `dist/`,
      `vx run build` prints `up-to-date` and leaves it there, so vx
      reports a hit over a tree that does not match the artifact it
      claims to have. Real code prints `restored-local` and wipes it.
      Pinned in `stale-hit.test.ts`, which is where the family lives.
      (b) THE WORKSPACE HALF of the fingerprint check. It is a
      conjunction over two roots, project dir and workspace root, and
      only the project half was held. Measured: a root-anchored output
      edited on disk to `CORRUPT` stays CORRUPT under a run reporting
      success; real code restores it. Pinned too.
      Each row is red for its own half and green for the other's.
      ALSO MEASURED, and NOT a defect: dropping the length half of
      `setsMatch` changes nothing, because a stray still fails the
      `every` and a missing file is caught by the fingerprint check.
      Redundant, recorded rather than pinned.
      OPEN, carried forward, not closed: two survivors I did not
      establish either way. `covers` in the directory short-circuit
      (a dirRow set that does not cover every prefix would let the
      walk be skipped — the same class as (a), reached by the dir
      path), and the post-restore `markOutputsChanged` (without it a
      downstream same-project task keeps a pre-restore git snapshot,
      which is key material). Both are plausible and neither is
      measured; they are the first thing to take after the trim.
472.  DONE (2026-09-20, the trim item 373's convention puts at forty —
      the loop had reached thirty-nine and the next sweep would have
      crossed it).
      Items 433–452 moved whole to
      `docs/history/2026-09-improvement-loop-433-452.md`, and handoffs
      14ao–14ap to `docs/history/2026-09-status-next-log.md`, leaving
      453–471 here. A PREFIX cut, as 373 set the rule and 452 last
      applied it: the formatter renumbers an ordered list
      sequentially, so cutting from the middle would renumber every
      entry below and break the cross-references that cite item
      numbers in this file, in the history files and in test comments.
      Cross-references to the moved items still resolve — the numbers
      do not move, which is the whole point of cutting a prefix — and
      several In-flight paragraphs still cite 435–443 by number.
      Written as three gated scripts rather than one, each idempotent
      and each checked on its OWN exit before the next ran, because a
      half-done trim has been committed here before (2026-09-16): the
      cut, the handoff move, and the index line. Each asserts what it
      is about to move (exactly twenty items, 433 first and 452 last;
      both handoffs present and no unwritten third) rather than
      trusting a line range.
