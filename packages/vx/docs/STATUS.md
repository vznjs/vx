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

## In flight

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
