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
(handoff 14am to the next-log file), so this file stays the handoff
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

414.  DONE (2026-09-20, `vx mcp` walked as the agent it serves, and the
      unknown-verb answer that sent me there). The MCP surface itself
      holds: driven over stdio as a client — `initialize` (both an old
      and the current protocol revision), `tools/list`, all six tools,
      then the shapes an agent gets wrong — every answer was right and
      every refusal named what to fix. A workspace nobody has run yet
      (no `.vx` at all) answers zeros rather than failing; a raw
      malformed line is `-32700`, `[]` is `-32600`, an unknown method
      `-32601`, an unknown tool a TOOL result rather than a protocol
      error; and the tools answer while a RUN holds the database, which
      is the case an agent hits most (asking "what is my cache doing?"
      during a build). Two probe-only corrections of my own: sending
      `'{ not json'` through `JSON.stringify` makes a valid JSON STRING,
      so the first parse-error row tested nothing; and `Bun.spawnSync`
      again (item 413) blocked the loop serving the stub.
      The defect is one step earlier, on the path to `vx mcp` at all. A
      plugin verb exists only because a workspace declares it, and the
      unknown-verb answer knew nothing about that: `vx mpc` in a
      workspace declaring `mcp` read as a plain unknown command with no
      "did you mean", and `vx mcp` before the plugin was declared said
      nothing about the file that would declare it. The lookup that just
      failed has the verbs in hand, so `resolvePluginCommand` now
      returns them (`{ declaredVerbs }`) instead of a bare null: they
      join the "did you mean" set, and when nothing is close enough to
      guess a second line says where a verb can come from — the verbs
      declared here, or that `vx.workspace.ts` is what would declare
      one, or that there is no workspace here at all. Core still names
      no package: it lists what the workspace itself declares.
      Four pins, all failing without the fix. One of them cost a
      correction: `helo` is ONE edit from both `help` and `hello`, so a
      test that expected `hello` was pinning which list is scanned
      first, not the behaviour — `hllo` is the honest input.
      Also from the walk: `getRunHistory` clamps `limit` to 1..500 by
      design (the schema publishes the bounds), but the answer did not
      say which limit it used, so an agent that asked for 10 000 and
      counted 500 rows could not tell a truncated list from an
      exhausted one. The applied limit now rides the result.

415.  DONE (2026-09-20, `@vzn/vx-otel` walked as its adopter, against a
      real collector). The suite next door injects `post`, so
      `defaultPost` — the code every adopter actually runs — had never
      been exercised: it awaited `fetch` and looked at NOTHING it
      returned. A collector that refuses the export ANSWERS rather than
      throwing, so a 401 from a wrong token, a 404 from a wrong path and
      a 500 from a wedged pipeline each exported nothing, warned
      nothing, and left the run green — the failure an adopter is least
      able to notice, because the plugin's whole promise is that it says
      nothing when it works. It now reads the status, warns with the
      collector's own message on one bounded line, and reports OTLP's
      other silent loss: a 200 whose `partialSuccess` says records were
      dropped. Seven rows, four failing without the fix; the three
      controls (a plain 200, a non-JSON 200, a `partialSuccess` with
      nothing rejected — the spec's own example of full success) pass
      both ways.
      What the walk confirmed, end to end through a real `vx run`, so it
      is not re-walked: a healthy collector receives all three signals
      (`/v1/traces`, `/v1/metrics`, `/v1/logs`) with a `vx.run` root
      span over `vx.task` children, and the run costs ~150 ms; a
      collector that never answers costs the run 3.1 s and ends with
      "telemetry flush timed out after 3000ms; buffered records lost" —
      core's teardown bound, not the sink's own 15 s, which is the
      invariant working; nothing listening at all warns per signal and
      finishes at the same ~150 ms; and with no endpoint configured the
      plugin declines in silence. The run exited 0 in every case.

416.  DONE (2026-09-20, `@vzn/vx-github` walked as a workflow runs it:
      the GITHUB_* environment Actions provides, a real job-summary file,
      a stub Checks API). Item 415's defect is NOT here, which was the
      first thing checked: `postCheckRun` reads `res.ok`, warns with the
      status and the API's own message, and a 403 even names the missing
      `permissions: checks: write`. Recorded so the shape is not
      re-checked a third time.
      What the walk confirmed end to end, every case exiting 0: a healthy
      environment appends the summary and POSTs one check-run in ~175 ms;
      a 403 and a 500 each warn once and cost nothing; an API that never
      answers costs 3.1 s and ends on core's flush deadline — the POST
      carries no deadline of its own, and the pending fetch does NOT hold
      the process, which was the open question (the otel sink's own
      comment warns that an un-unref'd timer does); with no token the
      check declines in silence and the summary still writes; and every
      run APPENDED, leaving an earlier step's content in the file intact.
      The find is a size asymmetry. The check-run output has been clamped
      to GitHub's 65 535 since it was written; the job-summary FILE was
      not, and GitHub rejects a step summary past 1 MiB outright — so an
      oversized page costs the adopter the whole summary rather than its
      tail. Measured rather than assumed: ~55 bytes a row (290 bytes at 2
      tasks, 539 094 at 10 000, 1 364 094 at 25 000), so the cap lands at
      about 19 000 tasks — which this repo's own bench generates at 5 000
      projects × four tasks. `clampJobSummary` now bounds it with the
      same kind of tell, cutting from the END so the verdict, the stats
      line and the Failures section survive. Two pins: the clamp (fails
      without it) and a CONTROL that an ordinary summary is appended
      whole with no truncation line.

417.  DONE (2026-09-20, `@vzn/vx-lockfile` walked as an adopter — the
      package closest to the worst failure class, since a mis-read
      lockfile gives a task the wrong dependency closure and a stale hit
      replays wrong bytes under a green run).
      The precision holds, end to end on a real workspace: changing ONE
      package's resolution in `bun.lock` moved `api#build`'s key
      (e25a09ee → e23c5db3) and left `web#build`'s untouched
      (d835c782 both times), and `--affected` across that commit
      selected api alone. Two controls: identical lockfiles select
      nothing, and a change that moves the root's digest selects the
      project the lockfile has no importer for.
      What it does with a lockfile it cannot read is also right — the
      run REFUSES, exit 1, rather than keying on nothing. Only the
      message was wrong, twice: the parsers name their own file and the
      plugin prefixed it again ("bun.lock: bun.lock: Failed to parse
      JSONC"), and nothing said what to do. It now prefixes only what
      does not already name the file and ends with the install that
      regenerates it.
      The `--affected` half had a sharper gap: the diff digests BOTH
      sides, so a base ref whose lockfile the current plugin cannot read
      — exactly what a lockfile-migration commit leaves behind — failed
      with the same bare message as a broken file in hand. Two very
      different problems with two different fixes. `lockfileClaim` now
      names the side: "(as of the base ref)" or "(in the working
      tree)". Two pins, both failing without their fix, each with a
      control that parses on both sides.
      Probe correction worth keeping: `--affected` on a repository with
      ONE commit answers "no base here", so the first version of the
      diff walk tested that error four times instead of the thing it
      was about. The scenario needs two commits.

418.  DONE (2026-09-20, `@vzn/vx-schedule-history` — the last unwalked
      plugin — and the three baseline failures it turned out to share a
      cause with). Its `test` task is red in the container baseline, so
      that came first, and the answer is environmental but only because
      it was measured: `resourceUsage().maxRSS` for a child that
      allocates 200 MB reads **235 604** here, which is the kernel's
      `ru_maxrss` in KILOBYTES. Core reads it as bytes, as Bun documents
      from the declared floor (>= 1.4), so the value lands 1024× small,
      falls under the parent-RSS floor, and vx records NO peak; the
      plugin then has nothing to learn, and the two rows that assert a
      peak and a learned reservation fail on a null. Core's own canary —
      "resourceUsageToCpuRss — peak RSS is bytes > reads a known
      allocation back as bytes, on THIS platform" — is red in the same
      baseline, which is the canary doing its job. Three baseline
      failures, one cause.
      A probe correction on the way, and it is the one CLAUDE.md already
      warns about in another form: my first reading was
      `JSON.stringify(proc.resourceUsage())` → `{}`, from which I
      concluded the runtime reports nothing at all. The fields are
      non-enumerable getters; reading them directly gave the real
      number. Stringify is not a way to ask whether a value exists.
      The rows now assert the premise instead of tripping over it: one
      measurement at module load (allocate 200 MB, read the peak back,
      compare against the allocation) and a named failure that says the
      runtime does not report bytes, which the canary measures. Same two
      test names, same baseline diff, 7 ms instead of 1.2 s, and on a
      supported runtime nothing changes — a skip would have been a
      silent pass.
      The walk itself found no defect, recorded so it is not re-walked:
      with an EMPTY history `vx history` says "no task has an execution
      in the window — run something first" and the first run schedules
      by core's order; with a THIN history (one run) the JSON carries
      `maxPeakRssBytes: null` and `reservation: null` rather than a zero
      or a NaN, so a null peak yields no reservation; and with a STALE
      history — every recorded task renamed away — the run is unaffected
      and `vx history` lists only the tasks a run would see now, because
      the rows are built from the resolved projects and joined to
      history, not the other way round.

419.  DONE (2026-09-20, the rule eleven walks taught, written where a
      plugin author reads it, and the handoff that closes the arc). Four
      of the finds in 413–417 were one shape — a failure the code
      HANDLED and did not report — and the guide that teaches the
      telemetry capability described only the other half, what happens
      when a sink THROWS (disabled for the run, a warning, the 3 s
      bound). A sink that catches its own I/O failure is invisible to
      core by construction, so the guide now says so: read the status of
      what you POST (a refusal answers, it does not throw), warn through
      `ctx.warn` with what the far side replied, once per destination
      rather than once per task. It names both shipped exporters getting
      it wrong the same way on the same day, because the evidence is
      what makes a rule stick.
      Checked rather than assumed: core's `docs/modules/plugins.md` is a
      seam table with no contract prose, so it needed nothing, and the
      extensibility guide's "never change, slow, or fail a run" is still
      true as written — the new paragraph is about what a sink OWES,
      not what it can do.
      Handoff 14al lands with it; 14ak moves to the next-log.

420.  DONE (2026-09-20, the warm path re-measured on this container, and
      what the numbers actually license). Nothing since 407 has touched
      the run path — 408–419 changed plugin code, tests and docs — so an
      A/B has no arms, and the honest version of Next 6's duty here is
      an ABSOLUTE refresh with the machine named. `run.ts 1000 5` and
      `5000 3`, medians with the full spread:
      1,000 — warm 271 ms (243–315), restore 1 031 (1 023–1 051), cold
      3 147 (2 905–3 388). 5,000 — warm 807 (760–809), restore 3 931
      (3 462–4 172), cold 14 181 (13 798–14 986).
      Against the 2026-09-16 table (a DEV BOX: 231 / 718 / 2 436 and
      687 / 2 854 / 12 152) this container is 1.17× on warm at both
      sizes, 1.38–1.44× on restore and 1.17–1.29× on cold. That
      comparison says nothing about vx — two machines — and is recorded
      only so nobody reads the container's numbers as a regression.
      What IS a claim about vx is the SHAPE, and it reproduces on
      hardware that shares nothing with the box that first measured it:
      5× the projects costs 2.98× the warm run here against 2.97× there,
      3.81× restore against 3.97×, 4.51× cold against 4.99×. The
      sub-linear warm scaling recorded on 09-16 is a property of the
      code, not of that machine.
      And a floor the next A/B needs: the bench harness's own warm arm
      spreads 243–315 ms about a 271 ms median on IDENTICAL code — ±13 %,
      twice item 404's in-process ±6 %, because each rep is a whole CLI
      invocation. A bench-level claim on this container needs a bigger
      effect than an in-process one does, and both need a control arm.

421.  DONE (2026-09-20, Next 16's design note — the half of it that is
      NOT gated). Next 16's own terms are "do it if a third repo shows
      the addition shape, with the design note first", so the note is
      unblocked work and the implementation is not.
      `docs/design/overlapping-outputs-2026-09.md` writes it down, and
      the reason it was worth writing rather than deferring is that
      reading the sketch against the code found a conflict the sketch
      does not mention. Its point 4, "the restore order follows the
      edge", contradicts the restore tier: a confirmed stable-key local
      hit becomes ready IMMEDIATELY because "a stable hit's restore
      needs none of its deps' output", and an overlap-narrowed artifact
      is exactly one that does. So the design needs a second stability
      axis — today's gate (`dependsOnSiblingOutputs`) asks where a task
      READS, and the overlap case is about where it WRITES.
      Checked rather than assumed, and the FIRST answer was wrong, which
      is item 422's whole content: the note's first draft said the
      cross-project case was unguarded. Same project (strapi, refine) is
      covered by the stability gate, as it said. Cross project is
      covered too, somewhere else — `local-shortcircuit.ts` disables the
      restore tier GRAPH-WIDE as soon as any task declares
      `cache.outputs.workspaceFiles`, for this exact reason ("the
      boundary-ignoring escape hatch could let a task write where a
      restore touches"). Measured rather than read: a fixture where B
      HITS while A MISSES (`cache.inputs.tasks: []` detaches B's key,
      the only arrangement that gets there — otherwise the cascade moves
      B's key with A's) put `b.txt` on disk at 1142 ms against `a.txt`
      at 1131 ms, so B restored AFTER A, and ten reps with a 2000-file
      producer left a correct tree every time. The note now says the
      constraint is "do not remove the exclusion that exists" and names
      who owns the case if the blanket rule is ever narrowed.
      The note also records what admitting refine's REWRITE shape would
      cost (a hash per overlapped file, bounded by the overlap rather
      than the tree — measurable, not obviously unaffordable, and
      unmeasured), and the four-case stale-hit test any implementation
      owes: A hit + B miss, A miss + B hit, both hit, both miss, each
      leaving a tree byte-identical to a cold run of both.

422.  DONE (2026-09-20, the design note's claim tested before it shipped
      — and refuted). Item 421 asserted that a cross-project
      `workspaceFiles` writer could be stable, restore-tier, and
      restored before its producer ran. That is what the stability gate
      alone implies, and it is not what vx does: `local-shortcircuit.ts`
      turns the restore tier off for the WHOLE graph when any task
      declares a workspace output, which is a blanket version of the
      same guard. The claim had already been written into a design note
      in an open PR, so the correction went to the note in place rather
      than into a new one.
      The probe is the value here, because the arrangement is not
      obvious. B cannot hit while A misses under normal keying — the
      cascade folds A's input key into B's — so the dangerous
      interleaving needs `cache.inputs.tasks: []`, the documented escape
      hatch for "keep this upstream from invalidating me". With that,
      B's key stands still while A's moves, and B is a hit whose restore
      could in principle land in a directory A is about to clean. Then
      the window has to be opened: A sits behind a one-second upstream,
      so a restore-tier B would write at t≈0 and A's clean would land a
      second later. Polling the directory through the run measured
      `b.txt` at 1142 ms and `a.txt` at 1131 ms — B restored after A,
      not before. Ten further reps with a 2000-file producer, and three
      earlier fixtures, all left a correct tree.
      The lesson is the one CLAUDE.md states and I re-learned anyway: a
      gate read in one file is not the system's answer. The guard that
      matters was in the consumer, not the classifier, and only the
      measurement found it.

423.  DONE (2026-09-20, the correctness sweep of `execute-task.ts` — the
      file STATUS calls stale-hit-critical, which nothing in the 408–422
      arc touched). Read against CLAUDE.md's live invariants, most of
      what the file claims is already pinned: the clean gated on WRITES
      rather than reads, `--no-cache` leaving the tree alone between
      retry attempts, an aborted task never cached, a timeout retried
      where an abort is not, a `preProbed` hit restored without a second
      probe, and the taint rule (`--continue=always never caches a task
built behind a failure`). Two claims were not.
      First, the asymmetry the file calls "the point": the wipe is gated
      on the WRITE axis, so `--force` (reads off, writes ON) must still
      wipe while `local:r` must not. Only the `local:r` half was pinned,
      and its comment pointed at `orchestrator.test.ts` for the other —
      where the wipe row runs the DEFAULT policy, both axes on, proving
      nothing about the asymmetry. The `--force` half is now a row, and
      the comment says what the neighbour actually pins.
      Second, `exec.remote: 'only'` on a `remote: true` executor: the
      comment promises no probe or restore, no output clean and no local
      artifact save — "restoring node_modules onto a dev machine is
      exactly what the field exists to prevent" — and nothing pinned any
      of the three. One row now drives `executeTask` with a fake
      far-side executor and asserts all three at once: zero `cache.get`
      calls, a leftover under the declared output still byte-identical,
      and no rows under the task's key.
      Both differential, and the mutations are worth recording: gating
      the clean on `willRead` fails BOTH halves of the asymmetry (which
      is what makes the pair a pair), and ignoring `remoteOnly` fails
      the third row alone.
424.  DONE (2026-09-20, the same standard applied to the OTHER
      stale-hit-critical surface: `src/cache/inputs.ts` (glob resolution,
      boundaries) and `src/cache/git-inputs.ts` (the git enumeration the
      key trusts), where a wrong answer is a wrong KEY rather than a
      crash). The unit-level sweep found nothing: prefix-stripping and
      "a modified tracked file is pruned from the trusted OID set" are
      pinned in `git-subdir-workspace.test.ts`; OID equality against
      git's own `hash-object`, sha256 repos, a symlink hashed as a blob,
      the mtime+size memo, dirty/untracked exclusion, a staged rename
      and merge-conflict stages in `git-oid.test.ts`; boundary
      non-crossing both ways, `ALWAYS_IGNORE` and `vx-lock.json` in
      `inputs.test.ts`; negation semantics and the `!!` inversion
      refusal in `inputs-resolution.test.ts`; the `..` segment refusal
      in `project-loader.test.ts`. Recorded as zero-yield rather than
      dressed up as work.
      What WAS missing is the composite. Each exclusion is pinned
      alone, on the resolver; none of them together on a real run with
      real discovery and a real git repo. `orchestrator-run.test.ts`
      now carries one: a project declaring the widest glob there is,
      `**/*`, with a declared workspace member nested INSIDE it,
      `node_modules` beside it and a sibling next door — change all
      four at once and the run must still HIT, then change the
      project's own file and it must miss. Differential twice over:
      returning `[]` from `boundaryIgnorePatterns` fails it, and so
      does dropping `**/node_modules/**` from `ALWAYS_IGNORE`.
      The fixture taught the rule it tests. The first version gave the
      nested member a `package.json` and no config, and the run MISSED
      — correctly: boundary geometry is built from CONFIG-BEARING
      projects (`prepare.ts`), so a bare manifest under a project is
      deliberately part of that project, not a fence. The test says so
      in a comment, because the shape is one a reader would otherwise
      read as a bug.
425.  DONE (2026-09-20, the pin item 421's design note asks for by name).
      That note ends with a constraint rather than a feature: the
      cross-project overlapping-outputs case is safe today only because
      `local-shortcircuit.ts` disables the restore tier GRAPH-WIDE the
      moment any task declares `cache.outputs.workspaceFiles`, and
      "whoever narrows that rule owns this case". A constraint nothing
      tests is a comment, so the tier's suite now carries it.
      The gap was specific. The existing row pins the DEPENDENT of a
      workspace-output producer — and that dependent is excluded for a
      second reason anyway (it is unstable). Narrow the rule to "the
      declarer and its dependents" and that row still passes. The new
      row uses a project with NO edge to the writer at all: `solo` and
      `wsw` share nothing but the graph, and `solo#build` must stay out
      of the tier while `wsw` declares a root-anchored output.
      The control is the same workspace with the writer's declaration
      changed to a project-relative output and nothing else — `solo`'s
      key is untouched and its artifact is the one the cold run just
      stored — and `solo#build` is restore-tier again. Without it the
      assertion would pass for a `solo` that simply never hit.
      Differential against the narrowing it exists to catch: scoping the
      exclusion to the declaring node fails the new row and leaves the
      neighbour green, which is the whole argument for adding it.
426.  DONE (2026-09-20, the third surface in the sweep: the stability
      gate, where a wrong "stable" verdict is a stale-hit vector —
      execute-task reuses a `preProbed` hash WITHOUT recomputing it).
      `dependsOnSiblingOutputs` and `workspaceInputsReach` are pinned
      case by case in `stable-keys.test.ts`, and the one-hop graph
      cases are in `local-shortcircuit.test.ts`. The FOLD that feeds
      the gate was not: `deriveStableKeys` accumulates transitive
      producers across the topo walk in two accumulators, and deleting
      EITHER line failed nothing — not the stable-key suite, not the
      short-circuit suite, not `stale-hit.test.ts`, not the whole
      repo's tests across every package (run twice, once per mutation,
      diffed against the container baseline: zero new failures).
      The test file's own header claimed the opposite — that its cases
      "exercise directly" the transitive fold. They hand the gate a
      literal producer set, so they pin the gate and never the fold.
      De-claimed in place and pointed at the rows that do, per the rule
      that a comment claiming a guarantee the code lacks is a defect.
      Each accumulator needs its OWN arrangement, which is why this is
      two rows and not one. For the project set the intermediate must
      be stable, so it sits in another project: `a#codegen` →
      `b#mid` → `a#consume`, and only the fold carries `a` across
      `b#mid`. For the workspace-output flag that shape proves nothing
      — a root-anchored producer makes its direct dependents unstable
      outright, so the intermediate would be unstable and the reader
      would inherit it. A GROUP task is the one intermediate that stays
      stable over such a producer (no cache, never gated, unstable only
      when a member is), so the second row is `wa#gen` → `wa#all`
      (group) → `wa#consume`. Each row fails under its own mutation and
      only its own.
427.  DONE (2026-09-20, and it is a ZERO-YIELD report — `cache/cache.ts`,
      1,637 lines, the local store itself, where wrong bytes under an
      unchanged key are the one situation a `CACHE_VERSION` bump exists
      for). Eleven claim families read and checked against the suites,
      every one already pinned, so the useful artifact is the map:
      the restore refusals (a vanished artifact, an archive missing a
      recorded output, the EISDIR/ENOTDIR stray, the `.vx-tmp-` race)
      in `artifact-roundtrip.test.ts` and `cache.test.ts`; the ingest
      boundary — corrupt zstd, valid zstd that is not a vx artifact, a
      declared bomb, a sizeless frame, a mid-stream cut, each asserting
      no artifact, no row and no temp — in `cache.test.ts`; the
      ms-precision output fingerprint on BOTH the save and the ingest
      path in `cache-baseline.test.ts` and `cache.test.ts`; `getMany`'s
      "same answers as N calls to `get`" in `cache-get-many.test.ts`,
      down to the read gate, the deferred `accessed_at` touch and (in
      `output-dirs-snapshot.test.ts`) the dir rows; orphan reaping with
      its grace window and four controls, and `orphanStats` agreeing
      with what prune reaps, in `cache.test.ts`; the key fold's order
      check including the inversion at the LAST pair and the
      workspace-root memo; the temp cleanup on both the in-memory and
      the streamed save path, each with its control; retention pruning
      `invocations` on the same window as `runs`; and the
      exit-code laundering defence, pinned twice — at runtime in
      `execute-task.test.ts` and at the TYPE level by a
      `@ts-expect-error` whose unused-directive error is the assertion,
      which only the lint gate can see.
      The most promising hole was the directory short-circuit, whose
      halves DO live apart — `hit-restore.ts` skips the output walk when
      every directory recorded at the last save still has its mtime,
      which is sound only if a snapshot covers the tree recursively and
      is all-or-nothing. It is both, deliberately (`output-index.ts`
      walks every subdirectory, abandons over `OUTPUT_DIRS_CAP`, and
      drops a snapshot holding any directory inside the racy window),
      and `output-dirs.test.ts` plus `output-dirs-snapshot.test.ts` pin
      the cap, the racy window and the absent-prefix row.
      One interaction is not pinned directly: a `vx cache prune`
      running while a save is mid-flight. It is not a gap worth a racy
      test — the mechanism that protects it is the orphan grace window,
      and that IS pinned deterministically (a fresh row-less artifact
      and a fresh temp are controls in the reaping row). A timed
      version would only prove that this box is slow enough.
      CLOSING THE METHOD. Four surfaces deep (423 `execute-task.ts`,
      424 `cache/inputs.ts` + `git-inputs.ts`, 426 the stability gate,
      427 here) the yield is 2, 0-then-a-composite, 2, 0 — and the
      finds cluster where a claim spans two files or two stages, never
      where one function does one thing. Sweeping a fifth file by line
      count is not the way to the next one; the next reader should look
      for a claim whose halves live apart, which is what 424 and 426
      both turned out to be.
428.  DONE (2026-09-20, and 427's prediction paid on the first try: the
      halves here are `exec/sandbox-binds.ts` and the promise the DOCS
      make about it). The sandbox is how a task proves what it touches
      — `--verify` was removed 2026-09-04 because the sandbox replaced
      it — so an undeclared in-project read is the stale-hit vector it
      exists to catch. Measured, five configurations, one variable at a
      time:
      `sandbox: {}` reading its own `src/x.txt` → failed, 1 violation.
      `read: ['src/**']` reading `src/x.txt` → success (control).
      `read: ['src/**']` reading an undeclared `undeclared.txt` →
      failed, 1 violation. The same task with `write: ['out.txt']`
      added → SUCCESS, 0 violations, and `out.txt` held the undeclared
      file's bytes. `write: ['dist/out.txt']` instead → failed again,
      1 violation, while `dist/sibling.txt` read fine.
      The mechanism is deliberate and documented IN CODE: on Linux a
      grant is a mount, bwrap cannot rename onto an active file mount
      (every atomic writer stages beside its target and renames), so
      `bindableWrites` binds a file-shaped grant as its DIRECTORY. The
      code names the cost on the write side — "the task may write its
      siblings". Nobody wrote down the READ side, which is the one that
      decides a cache key: that directory is readable in full, and
      there is no denial for the detector to report, because the read
      simply succeeds.
      So the defect is the claim, not the code: `schema.md` said the
      baseline grants "not even its own project directory" and that an
      undeclared read fails the task, `cli.md` said any undeclared
      touch fails, and the guide said only that a write grant is
      readable. All three now say what the boundary actually is and
      what moves it — keep declared outputs in a SUBDIRECTORY and the
      rest of the project stays provable. Two rows pin it both ways,
      Linux-only by construction (macOS seatbelt matches paths rather
      than mounting, so a file grant stays exact there).
429.  DONE (2026-09-20, and mostly a REFUTATION — recorded because a
      probe's negative result is worth as much as its positive one).
      428's thesis pointed at the next pair with halves in different
      files: `exec.env.passThrough` decides what the CHILD gets,
      `cache.inputs.env` decides what the KEY folds, and a mismatch is
      stale-hit shaped. I expected the same gap as 428. There is none.
      Proven the way 426 proved its own: fold every `passThrough` name's
      VALUE into the key and run every package's tests. Two rows catch
      it — `orchestrator.test.ts` § "cache.inputs.env affects the cache
      key; exec.env.passThrough alone does not" (which also asserts the
      stale bytes the hit replays) and `parity-turbo.test.ts` § "`env`
      is in the hash; `passThroughEnv` is not". The orthogonality is
      documented from both sides in `schema.md` and pinned from both
      sides in the suite.
      One direction was missing, and it is the one `schema.md` itself
      calls "legal but rare": a name in `cache.inputs.env` and NOT in
      `exec.env.passThrough`. Both existing rows pass every name through
      as well, so neither shows the isolated child — the key moves on a
      value the command cannot read, and the re-run reproduces identical
      bytes. Now a row, differential on both halves: ignoring
      `cache.inputs.env` in the key turns the miss into a hit, and
      leaking the parent environment past `buildIsolatedEnv` puts the
      value in the output.
      The lesson is about the sweep, not the code: I searched
      `orchestrator-run.test.ts` and `env.test.ts`, found nothing, and
      was ready to call it a gap. The suite's two halves live in
      `orchestrator.test.ts` and a parity file. Grep proves absence only
      where you grep; the repo-wide mutation is what actually answers
      "is this pinned", and it takes one run.
430.  DONE (2026-09-20). Two results, and the second one corrects the
      METHOD the last three items have been using.
      First, `--affected` against the key — the pairing `cli.md` states
      as a principle ("input hashing sees it, so `--affected` must
      too"). Four mutations in `workspace/affected.ts`, one per
      documented channel: drop the untracked union, stop widening on a
      root fingerprint file, stop widening when a claiming plugin
      cannot tell, and blind the config-import channel. Every one is
      caught, most of them several times over, including by a row
      named "the fingerprint moving and the selection widening are the
      SAME condition" — which is the two-halves invariant, already
      written as a test. Refuted, like 429.
      Second, and this is the correction: my verdict all along has been
      "the whole suite, diffed against the container baseline, saw no
      new failure". That diff is BLIND wherever the baseline is already
      red — a test that fails before the mutation cannot witness it —
      and the baseline's largest family is `vx watch`. So a mutation
      that deletes the watch loop's post-cycle re-trigger read as
      "nothing catches it" when five of the seven baseline failures are
      watch rows. Resolved by running the watch files ALONE:
      `watch-loop` and `watch-loop-members` pass here (their baseline
      failures are load), `watch-loop-selfwrite` and
      `watch-loop-uncached` fail even alone (18 s timeouts, this
      container). The mutation survives the two that pass, so the gap
      is real — but the earlier verdicts stand only because their
      mutations WERE caught, by green rows; a "nothing caught it" on
      this container is worth checking against the red list first.
      The gap itself: the inner loop re-runs while anything is pending,
      so that branch covers only the gap between its last judgement and
      the loop going idle — an event landing there sits in
      `pendingPaths` with no timer armed, and watch goes quiet over an
      edit the user made. The e2e fixture spawns a real `vx watch` and
      cannot deliver an event at that instant, so the decision is now a
      pure seam, `pendingAfterCycle`, with three rows: the first
      pending path under its own label, nothing pending, and aborted
      winning over a pending path (a SIGINT does not start one more
      cycle). What that pins is the decision, not the delivery window,
      and it says so.
431.  DONE (2026-09-20, acting on 430's lesson: a permanently RED row is
      a permanent blind spot). NOT a new diagnosis — item 369 already
      MEASURED the cause, and the In-flight section states it: Bun
      1.3.11's `fs.watch` never reports a DOT-prefixed filename (a plain
      file is delivered, `.vx-watch-probe` is dropped, both recursive
      modes), and that probe is exactly how `armWatcher` proves a watcher
      is live, so every `vx watch` here falls back to `pollWatcher` at
      250 ms and says so on STDERR. I re-derived it from scratch before
      reading that paragraph; the cost was an hour and the lesson is
      429's again, one level up — read what the file already says about
      the thing you are about to measure.
      What was missing is ACTING on it, and that is this item. Four rows
      asserted "exactly one extra execution per edit": true under
      events, where the task's own undeclared write arrives as its own
      event one window after the run. Under a 250 ms poll the edit and
      the write land in the same sample, so the follower never happens
      and the scenario settles at TWO executions, not three — measured
      three times, and for the plain, `rm -rf` and `rm -rf` + gap shapes
      alike. The rows now read the mode off vx's own announcement
      (`deliveryMode`) and assert the count for the mode they ran in,
      which also gives the polling path its first end-to-end coverage;
      it had only `pollWatcher`'s unit rows before.
      The fixture could not see that announcement at all: `startWatch`
      captured stdout and left stderr an undrained pipe. It drains both
      now — also one fewer way for a chatty watch to block.
      The two `armWatcher` rows are the ones whose SUBJECT is the native
      watcher, so they are gated on the capability the way the sandbox
      suites are gated on bwrap — by RUNNING `armWatcher` in a temp
      directory, because a gate that wrote the probe once was more
      pessimistic than the thing it gates and skipped a row that passes.
      It arms BOTH forms and wants both: a recursive-only gate said
      "available" in one of twelve shard processes and the NON-recursive
      row then failed there, so 369's "never" is really "almost never" —
      Bun 1.3.11 lands the hidden-file event occasionally, and the two
      modes do not fail together.
      Where the gate STOPS is measured, not assumed. It runs at import on
      an idle process; the rows run under twelve-way shard load. Six
      consecutive probes landed and the non-recursive row still failed on
      `armed.ready` in that same process — readiness timing out under
      load, not the capability missing. Tuning the probe further is
      chasing the load, so it stays at one probe per form, that row stays
      in this container's baseline beside the other load-shaped watch
      row, and CI requires both. CI sets `VX_REQUIRE_WATCH_EVENTS=1` on
      both jobs, so a runner that stops delivering is a failure there
      and not a silent skip.
      Not done, recorded rather than guessed: the probe's dot is an
      accidental coupling — readiness detection depends on hidden-file
      delivery, which is not the capability it means to test. A non-dot
      probe would decouple it, but on every SUPPORTED Bun (the floor is
      1.4) the current probe lands, so the change would be unmeasured
      here. Do it if a supported runtime ever drops it.

432.  DONE (2026-09-20, the trim item 373's convention puts at forty).
      With this entry the loop stood at forty, 393–432, so items
      393–412 moved whole to
      `docs/history/2026-09-improvement-loop-393-412.md` and the loop
      keeps 413–432. A PREFIX, for the reason item 373 recorded: the
      formatter renumbers an ordered list sequentially, so a cut from
      the middle renumbers every entry below it and silently breaks the
      cross-references in this file and in the test comments that cite
      item numbers. Counted: twenty out, twenty left (nineteen plus this
      entry), twenty in the new file; ten history heads and this file's
      own record paragraph repointed; handoff 14am moved to the
      next-log and 14an takes its place.
      A correction to item 412's record while acting on it. 412 reported
      the pointer clause in TWO spellings; there are THREE. The six
      oldest heads end "STATUS under the same numbering.", the newer ones
      end "`docs/STATUS.md`." — and among those the line break falls
      before "continue" in some files and after "in" in others, which is
      a third shape a regex written for the first two misses. The script
      asserted its way to that before writing anything (412's other
      lesson, kept): it refused on `373-392.md`, the regex moved to
      matching WORDS rather than layout, and the dry run then found the
      clause in all ten. Match on what the sentence says, never on where
      it wraps.

433.  DONE (2026-09-20, the pair handoff 14an named: the sandbox's
      grants against what `cache` declares — 428 came at it from the
      READ side, this is the write side, and it is the same shape).
      "The sandbox derives NOTHING from `cache`" is an owner call
      (2026-09-05) written into `sandbox-request.ts` and into
      `schema.md`: `cache.inputs` says what INVALIDATES a task,
      `sandbox.allow` says what it may TOUCH, and deriving one from the
      other coupled them in both directions — a declaration added for
      caching silently widened the sandbox, and a path the task needed
      had to be laundered through the cache key to get it.
      Nothing pinned it. The broad mutation (fold `cache.outputs.files`
      into every task's write grants) is caught, but only incidentally,
      by a row about a literal grant's failure MESSAGE. The surgical
      one — derive from `cache.outputs` only when the task declares no
      write grant of its own — survives every package's tests. That is
      the dangerous direction by construction: the task it widens is
      the one that asked for no write access at all.
      Two rows now, one config line apart with an identical cache
      block: a task declaring `cache.outputs.files: ['dist/out.txt']`
      and no write grant FAILS and leaves nothing on disk, and the same
      task with `write: ['dist/']` succeeds and writes the bytes. The
      pair fails under the surgical mutation and passes without it.
      Method note, because 430's correction is what made this verdict
      trustworthy: the sandbox family has ZERO rows in this container's
      red baseline, so "nothing caught it" here is a real answer rather
      than a blind spot — checked before the claim, not after.

434.  DONE (2026-09-20, the other pair 14an named — `vx watch`'s cycle
      against the run's ADMISSION — which turned into a find one level
      down, in admission's own taint rule).
      `taintTracker` treats four upstream outcomes as poison: `failed`,
      `aborted`, `skipped`, and anything already tainted (the
      transitive case, "or a grand-dependent would cache the same
      partial tree one hop later"). The e2e file reaches exactly two of
      them — a failed upstream and the hop through it. Dropping
      `'aborted'` from the rule, or `'skipped'`, survives every test in
      the repo.
      430's check first, because this area IS red here: the two
      `--continue=always` rows are in the container's baseline, so a
      full-suite diff cannot witness them. Run alone they pass, and
      alone they still pass under both mutations — the verdict is the
      file's own, not the diff's.
      Why an e2e cannot close it: the run shapes that produce an
      `aborted` or `skipped` upstream UNDER `--continue=always` are the
      ones a SIGINT or a filter creates, and arranging them races the
      thing being tested. `taintTracker` is an exported pure function
      taking the upstream outcomes directly, which is exactly the
      fabrication an e2e cannot do — so the rule is pinned there: one
      row per poison status, one for a clean upstream, one for the
      transitive hop, one for the disabled gate every other mode uses.
      Each fails under its own mutation; the transitive row fails under
      its own and takes the e2e with it.
      They live in a file of their own, and the reason is a small find
      in itself: written into `continue-taint.test.ts` they passed
      alone and failed all six in the sharded gate, because that file's
      module-level `beforeEach` builds a git repo per case and its
      commit fails there. Pure rows had inherited a fixture they have
      no use for. I wrote "under twelve-way load" here first; item 435
      measured it and it is not load at all — see there, and take this
      sentence as the lead it was rather than the cause.

435.  DONE (2026-09-20, chasing 434's lead — and the lead's own
      wording was wrong, which is the point of chasing one). Two rows
      of this container's red baseline are the `--continue=always`
      pair, recorded since 2026-09-19 as load ("they pass 3/3 in
      isolation and fail only beside eleven other shards"). They are
      not load. Shard 7 ALONE, with nothing else running, fails both.
      The cause is one line of the host's git configuration. This
      container signs commits through an external helper
      (`gpg.format=ssh`, `gpg.ssh.program` pointing at a signer that
      dials an MCP server on loopback), and a task sandbox denies the
      network — so `git commit` inside a sandboxed test task cannot
      reach its signer and exits non-zero. Unsandboxed, the same commit
      succeeds; that is why running the file directly passes and why
      the failure looked like concurrency.
      The repo already knew this. `tests/helpers/workspace.ts` runs git
      with `commit.gpgsign=false` and `tag.gpgSign=false`, which is
      exactly the guard, and that helper exists because "forty test
      files carried a private copy of the same scaffold". This file
      kept its own copy, without the flags. It uses the shared
      `gitInitCommit` now, and both rows pass inside the sandbox.
      The class is closed, not just the case: every other test that
      commits either passes `gpgsign` itself or goes through the
      helper — grepped, one file was unguarded, and it was this one.
      Baseline now 15–16 rows, from 23 this morning: 431 took six, this
      takes two more. Each one removed is a blind spot removed from
      every future mutation verdict, which is 430's whole point.

436.  DONE (2026-09-20, the next three baseline rows — and like 435
      they are not what the label said). The In-flight paragraph counts
      three `loadProjectConfig` rows as the runtime: "Bun 1.3.11 gets a
      `BuildMessage` where 1.4 gives the error its classifier turns
      into a `UserError`". Half right. The runtime does differ, but
      what the difference exposes is vx's own guard.
      Measured: on this Bun a `BuildMessage`'s prototype chain is
      `BuildMessage → Object`. It is not an Error. `configLoadError`
      opened with `if (!(err instanceof Error)) return null`, so a
      missing brace in a user's own config skipped the classifier
      entirely and reached them as a raw transpile object — the exact
      defect `isFsRefusal` exists to prevent one layer down, where the
      rule is already written: an FS refusal surfacing as an internal
      error is a defect, de-claim or implement.
      So the classifier matches on SHAPE now: an object carrying
      `name` of `ResolveMessage` or `BuildMessage` and a string
      `message`. That is NARROWER than the old guard for everything
      else — a config's own throw still passes through untouched — and
      it no longer depends on a runtime's choice about which class its
      loader errors extend.
      Two rows pin it where every runtime can see it. The three e2e
      rows only move on a Bun whose `BuildMessage` is not an Error, so
      on CI they prove nothing; a plain object with the right shape
      proves it everywhere, which is where the fix would otherwise have
      gone untested on the machine that gates merges. A third row
      keeps the narrowing honest: a plain `Error`, a `TypeError`
      shape, a string, `null`, and a name without a message all still
      return null.
      Baseline now 14 rows, from 23 this morning — and the number
      moved less than the three fixed rows suggest, which is its own
      lesson. Refreshing the yardstick from ONE run drops whatever
      flapped low that time, and two rows (`armWatcher` non-recursive,
      the zombie `isAlive`) then read as NEW on the next run. Read the
      diff in BOTH directions every time — what appeared and what
      vanished — or a flapper looks like a regression and a real
      regression hides behind one that flapped out.

437.  DONE (2026-09-20, the RSS family — six baseline rows, and the
      third label in a row that pointed at the runtime and turned out
      to point at vx). `runner.ts` said it plainly: "`maxRSS` is BYTES
      on every platform: Bun normalizes the kernel's `ru_maxrss` …
      as its typing says." That is a guarantee the code did not have.
      Bun >= 1.4 does normalize, and 1.3.11 does not — item 418
      measured the consequence (a 200 MB child reads 235604, which is
      kilobytes, falls under the parent floor and records nothing).
      The same file's history holds the OPPOSITE mistake: an
      unconditional ×1024 on Linux, which made a 64 MB suite read as
      64 GB and, once reservations were learned from that history, ran
      every task alone. Both directions come from asserting a platform
      unit instead of measuring it, which is a rule this repo already
      wrote down after paying for it once.
      The first fix compared this process's OWN
      `process.resourceUsage().maxRSS` against `ownRssHighWater()` and
      took the ratio. It passed the whole gate here and turned CI RED
      on BOTH platforms, which is the correction this entry exists for:
      `process.resourceUsage()` is the node-COMPATIBLE API and reports
      kilobytes even where `Subprocess.resourceUsage()` reports bytes.
      On a runtime already handing over bytes the ratio still read
      1024, so it multiplied — reinstating the 64 GB defect this file's
      history warns about. It agreed here only because both APIs use
      kilobytes on this Bun. Compare like with like, or do not compare.
      What shipped decides from the number in hand instead: no process
      peaks under a megabyte — a bare `true` costs a couple — so a
      reading below that is the kernel's kilobytes and multiplying is
      right by the same margin that makes the test safe. A real byte
      figure is never near the threshold, and neither is a real
      kilobyte one: the two live 1024× apart. No spawn, no memo, no
      second API to disagree with.
      Six rows green here: the two converter rows, `vx last`, the
      remote-usage e2e, and both schedule-history reservation rows —
      that last pair being the ones whose absence made the RSS family
      worth chasing at all. The plugin pair needed one more edit, and
      it is a nice illustration of a guard outliving its premise: item
      418 gave that file a probe that REFUSED to run the rows when the
      runtime answered kilobytes, which was right while core trusted
      the runtime's normalization and wrong the moment core started
      measuring it. The probe is gone; core's converter rows are where
      the unit is pinned, and the file says so.
      Two of my own rows had to be corrected on the way. One asked for
      a DEFAULT argument (`rssUnitScale(undefined, …)`), which was this
      process's live mark, so it turned on how heavy the test process
      happened to be: green alone, red in the shard. A row that moves
      with the harness is pinning the harness. The other is the
      calibration above — and the gate could not catch it, because the
      gate runs on the one runtime where the two APIs agree. CI caught
      it. A green gate here is not a green gate.

438.  DONE (2026-09-20, `bin.ts`'s truncated pipe — the row whose
      defect the Rules section already records as FIXED, which is what
      made it worth reading twice). The fix on 2026-09-15 was
      `process.stdout.end(() => process.exit(code))`: end's callback
      fires once the pipe holds it all. Measured true on Bun 1.4.2.
      On 1.3.11 the callback still fires early — 2 MiB written, 214 KB
      delivered — so the fix was not wrong, it was pinned to one
      runtime's idea of when a pipe is flushed.
      The form that does not depend on that idea is to stop calling
      `process.exit` at all: set `process.exitCode` and let the loop
      drain. Measured here — the whole 2 MiB arrives, `--version`
      returns in 72 ms, and the full `vx run ci --all` (44 tasks,
      sandboxes, caches, telemetry) exits on its own with its own
      verdict. The cost, stated because it is real: a verb that leaves
      a handle open now hangs instead of exiting, which the suite's
      several hundred spawns of this binary would show at once — and
      did not.
      The error path takes the same treatment for the same reason: a
      large stderr is truncated by `process.exit` too, and a message
      cut in half is the one a reader most needs whole.
      Baseline now 6 rows, from 23 this morning. What is left is the
      reapi CAS trio (the plugin refuses to LOAD on this Bun, with its
      own version error — nothing vx can do from here), the
      `Bun.Archive` tar oracle, `armWatcher` non-recursive, and the
      watch watched-set row.

439.  DONE (2026-09-20, the verdict method's THIRD correction, and
      this one is embarrassing in the useful way; the RSS re-fix it
      follows is recorded inside 437's entry, where the mistake was).
      CI stayed red on that fix, and the failing check was not a test at all:
      `@vzn/vx-schedule-history#lint.oxfmt`. My edit in 437 left two
      over-indented lines in that package's test file, and the
      formatter said so — in the LOCAL gate, twice, in the runs I
      declared clean.
      The hole is in what I diffed. `comm` against `base.names`
      compares failing TEST names, and a lint failure produces no
      `(fail)` row, so a formatting break is invisible to it. I read
      the failing-TASK COUNT (five, six, five) and never the task
      NAMES — and `CLAUDE.md` already says the gate is honest "against
      the failing-TASK set and the failing-TEST set together". I was
      using one of the two.
      So the yardstick is two files now, `base.names` and
      `base.tasks`, and the gate diff prints both. The task set on this
      container is four: shards 2, 7 and 8 (the reapi CAS trio, the tar
      oracle, `armWatcher`, the watch row) plus `@vzn/vx-reapi#test`.
      Anything else appearing there is mine.
      And then the same shape a second time in one turn, on the fix
      for it: the STATUS entry you are reading broke the formatter,
      and the command I checked it with was
      `bunx oxfmt --check docs/ >/dev/null && echo ok`. The "ok" never
      printed and I did not look for it. `CLAUDE.md` has that rule
      twice over — read the scan's exit, never a chain's last line —
      and I wrote a chain whose only evidence was a message that
      silently did not appear. What the formatter actually objected to
      is worth keeping too: it renumbered the entry from 440 to 439,
      because the ordered list has no 439 — the RSS re-fix rode inside
      437's entry rather than taking a number of its own.
      Three corrections to this method in one day — 430 (a red
      baseline cannot witness a mutation), 436 (refresh from one run
      and a flapper reads as new), and this one (a signal the diff
      never looked at, and then a check whose exit I masked) — and
      every one was found by something outside the diff. A verdict
      procedure needs its own controls as much as a test does.

440.  DONE (2026-09-20, the last baseline group, and the honest
      answer this time IS the runtime — with a convention the repo
      already owns for exactly that). `@vzn/vx-reapi` refuses to build
      a client on Bun < 1.4.0: older Bun hangs on the chunked uploads
      it makes, so `assertBunSupportsChunking` speaks instead of
      hanging. Every row that constructs one therefore cannot run here,
      and failing them reported a broken plugin where what this box has
      is an unusable runtime. Verified by reading the throw, not the
      label.
      The repo's rule for a capability a host lacks is written down
      twice already — the sandbox suites skip without bwrap and CI sets
      `VX_REQUIRE_SANDBOX`; the live REAPI suites skip without an
      endpoint and CI sets `VX_REQUIRE_REAPI`, "per the project rule
      that a skip is a silent PASS". The Bun floor is the same shape,
      so it now takes the same gate and the same flag: skip below the
      floor, and with `VX_REQUIRE_REAPI=1` throw instead. Both
      directions measured.
      The group was bigger than the yardstick showed, three times
      over, and that is the part worth keeping. The reapi task runs one
      bun process per file and stops at the first failure
      (`|| exit 1`), and `integrity.test.ts` sorts first — so gating it
      revealed three rows in `wire.test.ts`, gating those revealed
      three in `plugin.test.ts`, and gating those revealed eight in
      `wedged.test.ts`. Seventeen rows, not three, from one cause. I
      wrote "zero failing tests" in this entry before the gate showed
      me the second layer, and the third arrived after that. The way
      out was to stop peeling: run every file WITHOUT the fail-fast
      loop, once, and read the whole set. A fail-fast loop truncates
      the failing set as surely as a red baseline hides a mutation —
      the count was never the population.
      Local baseline now: THREE failing tests, from 23 this morning —
      `armWatcher` non-recursive and the watch watched-set row (both
      readiness or delivery timing out under twelve-way load, measured
      in 431), and the `Bun.Archive` tar oracle, which is the runtime
      itself. `@vzn/vx-reapi#test` is green here for the first time. Nine rows were fixed in vx's own code (431, 435, 436,
      437, 438), fifteen are gated on a capability this host lacks
      (431's two, this item's seventeen, and the RSS family's
      downstream that 437 made recordable), and what is left is the harness and a
      Bun version this repo does not claim to support.
441.  DONE (2026-09-20, the halves-apart thesis again, and this time
      the halves were a shared function and the two callers that read
      its answer differently). `staticPrefix` carries a comment saying
      two callers share it deliberately, "a second copy is how the two
      would disagree about what a prefix is" — and they disagreed
      anyway. The sandbox baseline joins the prefix onto a directory,
      so `path.join` folded `./`, `//` and `/./` before it ever saw
      one; the deferral gate compares two prefixes as raw strings, so
      it did not. Sharing the function shared only half the rule.
      Two defects, both measured, both with controls that pass either
      way:
      (a) `deferralEligibility` decides which producers may leave their
      outputs remote under `--download=none`. Its one real channel is a
      same-project reader whose `cache.inputs.files` can match the
      producer's outputs on disk — and `./out/**` against `out/**`
      compared as different prefixes, so the producer deferred. A local
      consumer materialises a deferred producer only AFTER missing, and
      `execute-task` derives the key first, so the consumer keyed two
      ways: `32aa46f2…` eager against `8136fcc5…` deferred, through a
      real `run()`, on one unchanged tree. `--download` is transfer
      tuning and is documented never to move a key; it moved one. Four
      of the five spellings `normalizeGlob` exists for defeated the
      gate (the trailing slash on a PATTERN happened to survive).
      (b) Then the class grep, which is where the second one came from:
      `outputsOverlap` refuses two tasks that declare the same output,
      because vx cleans declared outputs before a run and before a
      restore, so the second silently deletes the first's — the file's
      own words are "data loss with a green summary". It compares
      spellings three ways (literal = literal, `Bun.Glob` against a
      literal, glob = glob) and every one said "no overlap" for
      `./dist/app.js` against `dist/app.js`. Probed one spelling at a
      time: six pairs allowed that name one path.
      The fix is one rule in one place — `staticPrefix` normalizes
      before it takes the prefix, `outputsOverlap` normalizes both
      sides — plus a third gap the first test row found on its own: a
      literal's trailing slash survives `normalizeGlob` by design
      (`asTrees` owns `out/` → the tree), but it made `out/` compare
      unequal to `out`, so the prefix drops it. Normalizing is not a
      widening, and the controls say so: the disjoint pairs stay
      eligible, and `./dist/vx-*` against `dist/other.txt` — the
      measured case that killed the static-prefix approach for the
      refusal in the first place — still goes through.
      Ten new rows, all ten red without the fix, every pre-existing row
      green both ways. What made this findable was not reading a file:
      it was asking which OTHER consumer of a shared rule applies it
      differently, and the second defect came from grepping the class
      the first one belonged to, exactly as CLAUDE.md says to.
442.  DONE (2026-09-20, the shape 441 named, taken the same turn — a
      rule with three consumers where one reads it differently, and
      this one is the same function 441 fixed). `asTrees` is the rule
      that a literal entry is the file OR its whole tree: `dist` and
      `dist/` mean everything under `dist`, as in Turbo and every
      `.gitignore`, and `"outputs": ["dist"]` is the most common
      turbo.json shape there is. The input resolver reads it. So does
      `cleanOutputs`, which is what actually DELETES. The graph's
      overlapping-output refusal did not: it compared `dist` against
      `dist/app.js` as two unequal literals and let the pair through.
      Measured before the fix, through a real `run()`: `emit` writes
      `dist/app.js`, `wide` declares `dist`, the run reports **success**
      with both tasks green, and `dist/app.js` is gone. That is the
      exact sentence the file's own header carries — "data loss with a
      green summary" — produced by the check written to refuse it.
      The fix could not import the rule where it stood: `graph` may not
      import `cache` (the boundary matrix), and a second copy is what
      441 just measured the cost of. So `asTrees` moved to
      `util/paths.ts`, beside `normalizeGlob` and `staticPrefix`, and
      `cache/inputs.ts` re-exports it so the cache contract and its doc
      page stay true. `outputsOverlap` now expands both sides through
      it and applies its three existing rules pairwise.
      A row of the new test found the LIMIT, which is worth as much as
      the fix: `dist` against `dist/sub/**` is still allowed, because
      `asTrees` turns the literal into the glob `dist/**` and
      glob-vs-glob is the case this file deliberately leaves undecided
      rather than refuse a working build. It really does overlap and vx
      really will delete it; proving it needs the general intersection
      algorithm the file parks. Pinned as a limit, so the hole is a
      decision and not an accident.
      Five refusal rows, all five red without the fix. The controls that
      matter are the ones that pass both ways: the clean deletes the
      TREE for a literal directory and only the FILE for a literal file
      (the premise, or the refusal would be a false positive), a
      literal directory does not swallow a sibling or a same-prefix
      name (`dist` vs `distant/app.js`), and a literal file's `/**`
      twin matches nothing (`dist/app.js` vs `dist/app.js.map`).

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
    394, 400, 403, 409, 412, 419 and 426 (14–14am) are in
    `docs/history/2026-09-status-next-log.md`; 14ao below is the
    current one, and 14an above it is the one before.

14an. **Handoff after item 432 (2026-09-20).** Six items since 14am,
and they are one thread: the sweep method 427 closed, the thesis 428
proved, and then two refutations and a correction that together say
what the method is actually worth.
427 swept `cache/cache.ts` and found nothing — eleven claim families,
every one pinned, recorded as zero with the map of which test pins
what. Its conclusion was that the finds cluster where a claim's halves
live in different files or stages, never where one function does one
thing. 428 tested that immediately and it paid: `bindableWrites` binds
a file-shaped write grant as its DIRECTORY on Linux, so
`write: ['out.txt']` in a project root makes every root file readable
with no violation — the code documented the write half of that widening
and nobody wrote down the read half, which is the half that decides a
cache key. Three docs pages now say what the boundary is, with the
remedy (outputs in a subdirectory).
Then 429 and 430 refuted the next two candidates. The env axes are
pinned from both sides; `--affected` against the key is pinned four
channels deep, including a row named "the fingerprint moving and the
selection widening are the SAME condition". Both refutations cost one
mutation run each, and both taught more than a find would have.
429: grep proves absence only where you grep — I searched two files,
found nothing, and was one step from shipping a duplicate test as a
discovery; the coverage lived in a third file and a parity suite.
430: the verdict method itself was wrong. "The whole suite, diffed
against the baseline, saw no new failure" is BLIND wherever the
baseline is already red, and the baseline's largest family was `vx
watch`. That is how a live branch — the watch loop's post-cycle
re-trigger — read as unpinned when five of seven baseline failures were
watch rows.
431 spent the correction: the four red watch rows were root-caused (not
a new diagnosis — item 369 had it, and I re-derived it before reading
the paragraph that already said so), the rows now assert per DELIVERY
MODE so the polling fallback has its first end-to-end coverage, the
fixture drains stderr, and the two `armWatcher` rows are gated on the
capability with `VX_REQUIRE_WATCH_EVENTS=1` required in CI. Six
baseline failures gone: 23 red here became 17–18, ten failing tasks
became nine. Every one of those was a blind spot in every future
mutation verdict.
Open: Next 1, 2 and 16, each gated by its own terms; Next 6 has 404's
noise floor and no arms to A/B until the run path changes. The owner
residue — the `NPM_TOKEN` secret, the release cut, the site's address.
No open issues.
Next: the loop holds 413–432, twenty entries, so the trim is due again
at 452. For work, the honest position is that five of the seven
correctness surfaces probed in this arc came back pinned, and the two
finds (428, 431) both came from asking where a claim's halves live
apart — not from reading a file end to end. The remaining pairs of that
shape, untried: `vx watch`'s cycle against the run's admission dedup
(430 opened it and only took the branch), and the sandbox's grants
against what `cache.outputs` declares, which 428 touched from the read
side only. Never end with "what next?".

14ao. **Handoff after item 441 (2026-09-20).** Nine items since 14an,
and the arc ends with the baseline honest and the method sharper than
the finds.
433–440 were the baseline: every row that read "the runtime" got read
instead of believed, and five of them were vx's own code (435 a git
fixture, 436 an `instanceof Error` guard, 437 a platform unit asserted
instead of measured, 438 a flush pinned to one runtime's timing). 440
gated seventeen reapi rows on the Bun floor the plugin itself declares,
using the convention the repo already owns for bwrap and for a live
endpoint. Twenty-three failing tests this morning, three now — and all
three are honestly the harness or a Bun this repo does not claim to
support. DO NOT chase them, and do not invent work to reach zero.
441 is the one to copy. It came from asking which OTHER consumer of a
shared rule applies it differently — not from reading a file — and it
found a key that moved with `--download` and an output-collision
refusal that missed the same path spelled two ways. The second came
from grepping the class the first belonged to, which is a standing rule
here and paid a defect this time.
The method, after four corrections in one day (430, 436, 439, 440):
mutate and run the whole suite; check the mutated area against the red
baseline BEFORE reading a verdict; diff both yardsticks, failing TASKS
and failing TESTS, in both directions; never let a check's exit hide
behind `&& echo ok` or a pipe; and remember a fail-fast loop truncates
the failing set, so run a package's files individually before believing
a count.
Open: Next 1, 2 and 16, each gated by its own terms; Next 6 has 404's
noise floor and no arms to A/B until the run path changes. The owner
residue — the `NPM_TOKEN` secret, the release cut, the site's address.
No open issues.
Next: the loop holds 413–442, so the trim is due at 452. For work, the
shape that has paid every time in this arc is a claim whose halves live
apart. Still untried: `vx watch`'s cycle against the run's admission
dedup (430 opened it and only took the branch), and the sandbox's
grants against what `cache.outputs` declares, which 428 touched from
the read side only and 433 pinned from the derive side. And the shape
441 adds to that list: a rule shared by three consumers where only some
of them apply it — `asTrees`, `normalizeGlob` and `staticPrefix` each
have more than two callers. Item 442 took `asTrees` the same turn and
found the third consumer reading it differently, so the remaining one
of that shape is `normalizeGlob`'s own callers.

LEAD RESOLVED the same turn, and it corrects ME twice before it
corrects anything else (2026-09-20, while probing 442). The lead was
"a sandboxed task reported success having produced nothing, with no
violation and no warning, contradicting a row that passes here".
Both halves of that sentence were wrong, and the way each was wrong is
the part worth keeping.
There was no contradiction. The suite's row declares an explicit
`sandbox: { allow: { read: [...] } }` with no write; my probe declared
the bare baseline `sandbox: {}`. Two different configurations, so the
two results never disagreed — I compared a row's CONCLUSION with a
probe's, without comparing their fixtures.
And vx did warn, in the exact words miss-save has for it:
`[vx] app#build: cache.outputs matched no files (dist/**) — an empty
artifact is saved; a later hit restores nothing`. My probe's logger
implemented `taskStdout`/`taskStderr` and dropped `log.status`, which
is the channel that line uses. A probe that silences a channel cannot
report what that channel said — the same shape as 439's `&& echo ok`,
one level up: I read an absence that my own instrument created.
What the probing DID establish, item 443's and the only one of the two
that is real:
(a) `SandboxConfig` in `src/config.ts` — the type a user reads in
their editor — says the baseline "may read its resolved
`cache.inputs.files`, write the prefixes of its `cache.outputs.files`",
and says it again on `read` ("beyond the resolved `cache.inputs.files`")
and on `write` ("beyond the `cache.outputs.files` prefixes"). The code
deliberately derives NOTHING from `cache` (owner, 2026-09-05; stated in
`sandbox-request.ts`, pinned by 433, and `sandbox-request.ts:140` binds
`sandbox.allow?.write ?? []`, never the cache). `schema.md` already
says it correctly. So the prose doc is right, the code is right, and
the TYPE's own comment promises a grant the sandbox does not make — on
a security boundary. CLAUDE.md names this exactly: a comment claiming a
guarantee the code lacks is a defect, de-claim or implement.
(b) NOT A FINDING, and the third correction in this thread — recorded
so that nobody "fixes" it. A write grant spelled as a bare literal
directory, `sandbox: { allow: { write: ['dist'] } }`, becomes a
placeholder FILE at `dist`, and the task dies on `mkdir: cannot create
directory 'dist': File exists`. I measured that and was about to write
it up as 442's ambiguity reaching the sandbox. It is a DECIDED
behaviour, and both halves of the decision were already written down
before I got there: `prepareOutputsForBind`'s own comment describes
this exact scenario, dated 2026-09-16, down to the tool the user meets
it from — "a literal that names nothing yet is a FILE — `dist/vx` for
`bun build --outfile dist/vx`" — and concludes "so a directory is
spelled `dist/`"; and `schema.md` says the same to users under "A write
grant's shape". bwrap cannot bind a path that does not exist and vx
cannot know which an absent grant means, so the spelling is the answer.
This is 429's lesson with the grep actually done: I looked before
claiming, and the claim did not survive. Never end with "what next?".

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
    third repo shows the addition shape, and leave the rewrite refused.
    THE DESIGN NOTE IS WRITTEN (item 421,
    `docs/design/overlapping-outputs-2026-09.md`): read it first, because
    it found a conflict this sketch does not mention — point 4's "restore
    order follows the edge" contradicts the restore tier, and an
    implementation must add a second stability axis (where a task WRITES,
    not only where it reads) before a narrowed artifact is safe.

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
