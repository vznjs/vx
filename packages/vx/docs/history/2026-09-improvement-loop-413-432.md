# Shipped, 2026-09 — improvement-loop items 413–432

The record `docs/STATUS.md` carried until 2026-09-20, moved here whole
when the loop reached forty entries again. A PREFIX, as item 373 set the
rule: the formatter renumbers an ordered list sequentially, so a cut from
the middle would renumber every entry below it and break the
cross-references that cite item numbers here, in STATUS and in the test
comments.

Items 1–64 are in `2026-09-review-arc.md`, items 65–104 in
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
`2026-09-improvement-loop-393-412.md`; items 433 onward continue in
`docs/STATUS.md`.

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
