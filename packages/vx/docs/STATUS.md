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
(handoff 14aj to the next-log file), and items 393–412 to
`docs/history/2026-09-improvement-loop-393-412.md` later that day
(handoff 14am to the next-log file), and items 413–432 to
`docs/history/2026-09-improvement-loop-413-432.md` on 2026-09-20
(handoff 14an to the next-log file), and items 433–452 to
`docs/history/2026-09-improvement-loop-433-452.md` on 2026-09-20
(handoffs 14ao–14ap to the next-log file), so
this file stays the handoff
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

## In flight

**`shard-9` segfaults about 1 run in 8, on any tree (measured
2026-09-20, item 483).** `bun test` over the shard's 17 files in ONE
process dies with `panic(main thread): Segmentation fault` and exit 132
(128 + SIGILL) — Bun's own message says it is a bug in Bun. No file in
the shard reproduces it alone. Interleaved A/B, same file list both
ways: pristine 1/10, a docs-and-one-unrelated-test diff 3/11. It is
deliberately NOT in the task baseline: a baseline entry would swallow a
real shard-9 failure. When a gate run shows shard-9 failed with the
NAMES yardstick unchanged and no `(fail)` row, re-run the shard before
reading anything into it. The panic text VARIES: item 512's gate hit
`panic: Floating point error at address …` rather than the segfault,
same shard, same exit 132, same absence of a failing row, and it passed
on re-run with vx recording the task flaky. Match the signature (exit
132 + a Bun panic + no failing row), not the panic's wording.

**The gate's baseline in a cloud container (2026-09-19; the RSS family
diagnosed 2026-09-20, item 418).** Three of the failures are one chain:
this container's Bun reports `resourceUsage().maxRSS` in the kernel's
KILOBYTES, core reads the bytes Bun >= 1.4 documents, so every peak reads
1024× small, falls under the parent-RSS floor and is never recorded —
core's `resourceUsageToCpuRss` canary rows and both
`@vzn/vx-schedule-history` memory rows follow from that one fact.

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
with its own version error (3 in the failing set, but SEVENTEEN rows
behind it: the task stops at the first file, so the count was never the
population — item 440 gated them all and that task is green here now),
`tar-stream` fails inside
`Bun.Archive` (1), `project-loader` got a `BuildMessage` where 1.4
gives an Error — item 436 measured that and fixed the guard behind it,
so those three are no longer in the set (3), the
runner read no `peakRssBytes` at all until item 437 measured the unit
instead of trusting it (2), and `bin.ts` truncated a
2 MiB pipe write to 219 KB, the very defect the Rules section records
as fixed — item 438 found the fix pinned to one runtime's flush timing
and took `process.exit` out of the path entirely (1). Four more are downstream of that missing usage number
(`vx last`, the remote-usage e2e, both schedule-history reservation
cases). Seven WERE the watch loop and `armWatcher`, and item
369 MEASURED what this sentence first guessed: they are the floor too.
Item 431 acted on that measurement, so they are no longer in the set:
the four e2e rows assert per delivery mode (the poll coalesces the
follower, so two executions there and three under events), the two
`armWatcher` rows are gated on the probe landing at all, and the
seventh was load and passes alone.
The baseline stands at THREE failing tests as of item 440
(`armWatcher` non-recursive, the watch watched-set row, the
`Bun.Archive` tar oracle) and three failing tasks.
Bun 1.3.11's `fs.watch` never reports a DOT-prefixed filename — a
plain file is delivered, `.vx-watch-probe` is dropped, in both
recursive modes — and that probe is exactly how `armWatcher` proves a
watcher is live. So 21 of the 23 are the runtime, not 10. That leaves TWO — the
`--continue=always` pair — which item 435 measured and which are NOT
load either: this host signs commits through a helper that dials
loopback, a task sandbox denies the network, and that file was the one
test with a private git runner missing the `commit.gpgsign=false` guard
the shared helper carries. Fixed there, so load explains none of the
23; what it explains is the SIGILL shape below and the watch timing 431
left in place. The controlled comparison closes it: CI pins
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
   run-path change. REFRESHED 2026-09-20 (item 420): this container, at
   1,000 projects, reads warm 271 ms / restore 1 031 / cold 3 147, and at
   5,000 warm 807 / restore 3 931 / cold 14 181 — the dev box's figures
   below are a DIFFERENT MACHINE and only the 1k→5k scaling (×2.98 warm
   here against ×2.97 there) compares. The harness's warm arm spreads
   ±13 % on identical code. UNPARKED 2026-09-20 (item 404), with the
   container's own noise floor measured first: interleaved min-of-7, one workspace
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
    394, 400, 403, 409, 412, 419, 426, 432, 441 and 452 (14–14ap) are
    in `docs/history/2026-09-status-next-log.md`. The loop below is the
    record since 453; the next handoff written here is 14aq.

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
