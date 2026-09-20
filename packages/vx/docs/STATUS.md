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
(handoff 14an to the next-log file), so this file stays the handoff
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
443.  DONE (2026-09-20, the one real finding left from 442's probing —
      a comment claiming a guarantee the code lacks, on a security
      boundary, which CLAUDE.md names as a defect class). `SandboxConfig`
      in `src/config.ts` is the type a user reads in their editor. It
      said the sandbox baseline "may read its resolved
      `cache.inputs.files`, write the prefixes of its
      `cache.outputs.files`", and said it again on `read` ("beyond the
      resolved `cache.inputs.files`") and on `write` ("beyond the
      `cache.outputs.files` prefixes").
      The code derives NOTHING from `cache`, deliberately (owner,
      2026-09-05; pinned by 433). Read at the source rather than
      inferred: `sandboxRequestFor` builds the request with
      `baseAllowRead: depDirs` — project `node_modules`, workspace-root
      `node_modules`, and the real paths of the workspace symlinks
      inside them — and `baseAllowWrite: []`, literally empty; it passes
      `sandbox.allow?.write ?? []` to `prepareOutputsForBind`;
      `resolveSandboxConfig` reads only `cfg.allow.read` /
      `cfg.allow.write`. `schema.md` already stated it correctly and
      more sharply than I first wrote it ("the task reads nothing,
      writes nothing … not even its own project directory"), so the
      comment now matches that wording and points at it.
      De-claimed, not implemented: the behaviour is the owner's call.
      The drift channel is the part worth keeping. Every existing
      sandbox row — 433's, and "a declared OUTPUT is not a write grant:
      the task fails" — declares an EXPLICIT `allow` block. The BARE
      `sandbox: {}` baseline, which is precisely what the comment
      described, had no test at all. A security-boundary claim that no
      test reads is how a comment gets to say the opposite of its own
      file's neighbour. It has two rows now, one line of config apart:
      with no grant the task's `mkdir` is refused (`Read-only file
system`, run failed, nothing on disk), and with
      `allow: { write: ['dist/'] }` the same task lands `dist/app.js`.
      A correction to my own probe, found by writing the row: in a
      normal workspace the baseline denies the write LOUDLY and the run
      fails. My scratch probe — a single package whose project dir was
      the workspace root — instead went green with the bytes evaporating
      silently. I tried to replicate that with the suite's helper and
      the attempt was not faithful (no task ran at all), so WHY those
      differ is open and NOT established. It is written here as a
      question, not a cause; anyone taking it should start by building
      the root-as-project layout faithfully and confirming the
      difference exists before explaining it.
444.  DONE (2026-09-20, the question 443 left open — answered, and the
      obvious fix MEASURED AND REJECTED, which is the useful part).
      The phenomenon is real and the variable is the layout. Faithful
      A/B, one helper, one config, one command, only the layout
      differing: with the project dir nested, a sandboxed task with no
      write grant is refused outright and the run FAILS; with the
      project dir equal to the WORKSPACE ROOT, the same task exits 0
      having written into scratch that evaporates. The second is the
      worse failure: an empty artifact is saved under a valid key, and
      a later run hits it and restores nothing — miss-save's own "the
      build that ran nowhere looks like a build that ran".
      Mechanism, read in SRT's source rather than inferred: a directory
      read-deny is implemented as `--tmpfs` over that directory
      ("mount a tmpfs over a read-denied directory, then restore the
      allowed write paths and allowRead paths the tmpfs just wiped").
      vx passes `baseDenyRead: [workspaceRoot]` with `cwd: projectDir`;
      when those are the same path the tmpfs lands ON the cwd, so the
      task writes into it.
      The fix I sketched — drop the anchor when `projectDir ===
workspaceRoot` — is REFUTED, twice over, and neither refutation
      came from thinking about it. First, tracing the consumers:
      `parseStraceViolations` uses `denyRead` as its coarse pre-filter
      ("only report paths under the workspace-root deny anchor"), so an
      empty anchor list filters out EVERY Linux violation — a silent
      reporting hole in place of a silent enforcement one. Second, and
      decisively, measuring it: with the anchor dropped the root arm's
      write IS properly refused, and the task can now READ its own
      project, which the documented baseline says it cannot. The anchor
      is what enforces "reads nothing, not even its own project
      directory". With SRT's primitive the two are inseparable.
      So no enforcement change. What IS vx's, and shipped: the one
      signal that fires in the silent case now names the cause. When a
      task declares `exec.sandbox` with no `allow.write` and its
      outputs match nothing, the warning adds "the task is sandboxed
      and declares no exec.sandbox.allow.write, so its writes never
      reached disk". Config-only, so the rows assert the message's rule
      rather than a platform's denial: one row red without the change,
      two controls green both ways (a task that DID declare a grant,
      and a task that is not sandboxed at all — the second runs
      everywhere, since the first needs a real sandbox).
      `schema.md` now states the layout-dependent failure and why the
      anchor stays.
      Worth keeping about the method: the naive fix would have passed a
      gate. It makes the arm under test behave correctly, and the
      damage — no violations reported, project readable — is in two
      places nobody was looking at. Trace every consumer of a value
      before removing it, then measure what removing it does to the
      claims OTHER tests make.
445.  DONE (2026-09-20, the last rule of the halves-apart shape —
      `normalizeGlob`'s own callers — and it found TWO consumers
      reading it differently, one of them created by items 441 and 442
      themselves).
      The query was mechanical: every `new Bun.Glob(` on a path that
      comes from user config, then ask whether the rule is applied
      before the match. Nine sites, two gaps.
      (a) `@vzn/vx-migrate`'s `shared-outputs.ts` carried a verbatim
      COPY of core's `outputsOverlap`, and said so: "core's
      task-graph.ts, the same conservative test". It stopped being the
      same test the moment 441 and 442 widened core's, and the file's
      own header says what that costs — "the refusal came at load time,
      after the migration had reported clean". Measured: the copy
      missed `./dist/**` vs `dist/**`, `dist//**` vs `dist/**`, and the
      literal `dist` against both `dist/app.js` and `dist/**` — and
      `outputs: ["dist"]` is the commonest turbo.json shape there is
      (442), so this is the ordinary Turbo migration, not an exotic
      one. Fixed by deleting the copy: `outputsOverlap` is exported
      through the façade (a deliberate widening, Rule 3, snapshot
      updated with the reason) and vx-migrate asks core's own question.
      (b) `workspaceGlobsMatch` in `workspace/affected.ts` decides
      whether a changed workspace-root file marks a project affected,
      and its doc says it "mirrors `resolveWorkspaceFiles`' partition".
      The resolver runs `asTrees` on both sides; the mirror built raw
      globs. Five spellings where the KEY folds the file and the mirror
      matched nothing, so `vx run --affected` left out a project its
      own key called stale — a missed rebuild, which is the one
      direction selection may never take. `asTrees` on both sides now.
      The rest of the sweep, recorded because a refutation is worth as
      much: `workspace.ts` already normalizes at its partition (with a
      2026-09-10 comment recording that exact fix), and `filter.ts`,
      `sandbox-runtime.ts` and `sandbox-request.ts` are safe by
      construction — `path.resolve` / `path.relative` / `path.join`
      fold the spellings before the glob is built, which is why 441's
      two callers disagreed in the first place. One site left
      deliberately: the sandbox's `ignore` patterns, documented as
      patterns rather than paths, where a missed match still REPORTS
      the violation — the fail-safe direction.
      Method note: the (b) rows first shipped with a "CONTROL" that
      failed without the fix, because I had put a real fix assertion
      (a loosely-spelled negation) inside it. A control that moves with
      the change is not a control; it was split into its own row so the
      differential means what it says.
446.  DONE (2026-09-20, the same query as 445 pointed at the rest of the
      sibling packages — and it is MOSTLY A REFUTATION, which is the
      honest headline).
      Two candidates from handoff 14ao closed first, both refuted for
      nothing: `vx watch`'s cycle against the run's admission DEDUP is
      not an interaction at all — watch holds an explicit reentrancy
      guard ("never two orchestrator runs in flight") so cycles never
      overlap, and it passes no `inflight` registry, so `admitTasks`
      takes the untouched path every cycle; the dedup is for an
      embedder running concurrent delegated runs, which watch is not.
      The adjacent worry, that watch calls `run()` with the SAME
      options object every cycle, is clean too: `run()` does not mutate
      its options. And 434 had already taken the watch-vs-admission
      pair proper — it became the taintTracker find — so 14ao's "still
      untried" line was stale and is corrected here.
      Then the 445 query across every sibling package: logic that
      claims to mirror core, or re-implements what core does not
      export. The announced kind came back CLEAN — `@vzn/vx-otel`
      imports core's `TaskLogBuffer`, `@vzn/vx-github` imports core's
      escaping and status predicates and diverges only on layout,
      deliberately and in writing. The one announced copy that had
      drifted was 445's, already fixed. That is a real result: the
      façade discipline holds across the packages.
      The unannounced kind found duplication without a realistic
      defect, and it is recorded as such rather than dressed up.
      `relPosix` existed FIVE times — once in core (not on the façade)
      and four times in `@vzn/vx-migrate` — three identical and one
      mapping the same-directory case to `.`, a divergence its only
      caller makes unreachable by returning early on equality. The
      `scripts` read existed twice unguarded where core guards it; the
      guard's difference is reachable only for a task named by a DIGIT
      against a malformed `scripts`, which is not a workspace anyone
      has.
      Consolidated anyway, into `vx-migrate/src/paths.ts`, for one
      reason worth stating: item 445 is what a copy in this same
      package costs once it drifts, and the cheapest moment to collapse
      a duplicate is before that. No façade widening — the helper is
      local to the package that needed it.
      The type-checker then found the part that was more than tidying.
      Making the `scripts` read honest (`Record<string, unknown>`)
      broke `mapCommand`, which declared `Record<string, string>` — so
      `body.length` type-checked on a value the boundary need not have
      made a string. That is now read and validated like its Turbo
      sibling. The instrument found it; I did not.
447.  DONE (2026-09-20, the correctness sweep turned on
      `orchestrator/run.ts` — 1,048 lines, the largest file the arc had
      never swept).
      Four load-bearing claims mutated, one at a time, each against the
      whole repo.
      CAUGHT (2): the drain-before-teardown ORDER — moving
      `teardownPlugins` ahead of `cache.drainUploads()` fails the
      `hasRemote` row, which checks the order and not merely that both
      ran; and history's never-fail — rethrowing from the
      `recordRunBundle` catch fails the row that pins a run record it
      cannot write as a status line.
      SURVIVED, and it is the find: deleting `closeCache()` from run()'s
      `finally` breaks NOTHING. The comment there says the handle must
      be released "on EVERY exit path, not just the happy one", because
      `close()` is where the run's deferred `accessed_at` batch is
      flushed — a hit only adds its hash to `touched` — so a throw
      between opening the cache and the normal close leaks the SQLite
      handle AND loses the run's touch record, "after which an LRU
      `vx cache prune` can evict entries the run just hit".
      The sharp part is why it went unpinned, and it is this arc's shape
      again: a row DOES exist naming that exact hazard — "a run record
      that cannot be written is a status line; the cache handle still
      closes" — and it spies on `close` and asserts it ran. But
      `recordRunBundle`'s throw is CAUGHT, so that run finishes and
      closes on the NORMAL path. The claim is every exit path; the
      coverage was one of them, and the row's own name reads as though
      it were both.
      Pinned now with the one lever that reaches the other path: a
      plugin cache layer whose `drainUploads` throws — the single await
      in the normal path that is not wrapped — so the run takes its
      hits and dies before its own close. The row reads `accessed_at`
      out of the cache DB and requires the bump; red without the
      `finally`, green with it, and the sibling row is cross-referenced
      from it so the pair reads as the pair it is.
      SURVIVED and DELIBERATELY NOT PINNED (1): dropping the once-only
      guard on `closeCache` also breaks nothing, but that claim is COST,
      not correctness — a second close just re-runs the 30-day
      retention DELETEs, and the `finally` already swallows a throw. A
      test for it would have to count calls, which pins the
      implementation rather than the guarantee. Recorded as measured
      and left, with the reason, so it is not rediscovered as a find.
448.  DONE (2026-09-20, the sweep continued onto
      `exec/sandbox-runtime.ts` — 1,034 lines, the other file Next 8(d)
      names as large and unswept — and it pays again).
      Three claims mutated, one at a time, each against the whole repo.
      CAUGHT (2), and both refutations are worth the run they cost. The
      synthesized "this sandbox grants no read access to your own cwd"
      violation is added only when the task ALREADY failed with nothing
      to show, "so it can never redden a pass": dropping that guard
      fails SIX rows, two of them written earlier today. And the
      `updateConfig` hot reload after a probe-initialized SRT — the fix
      for an availability probe that had brought SRT up with an EMPTY
      config, so the run's own allowlist never reached it — is caught by
      the port-bridge row, which is exactly the test the comment says
      found the original defect in the first place.
      SURVIVED, and it is the find: the strace log path is keyed by the
      task's command tag so "parallel tasks don't share a stream", and
      pointing every task at ONE path breaks nothing in the repo. It is
      not a cost claim. `strace -o` TRUNCATES, so a second sandboxed
      task starting mid-run destroys the first one's trace: the denial
      still happens (bwrap enforces either way) but the EXPLANATION is
      gone, which is the one thing this file works hardest to
      guarantee — its own words, "a sandboxed task that fails must say
      what it was denied".
      Pinned with two denied tasks run at concurrency 2, each reading
      its own undeclared file, asserting each outcome's own violation
      COUNT. Red 3 times out of 3 under the mutation, green with the
      fix. Linux-gated, because strace detection is the Linux path.
      The tasks sleep briefly so the traces overlap; that is a harness
      device to make the concurrency real, and the assertion is a count,
      not a duration.
      Two files swept now (447, 448), seven claims, two finds, five
      refutations. The method is still paying, and what it keeps
      finding is not wrong code — it is a true claim nothing was
      holding.

449.  DONE (2026-09-20, `cli/watch.ts` — 1,145 lines, the LAST of the
      four files Next 8(d) names as large; `cache/cache.ts` was 427's
      zero, `orchestrator/run.ts` 447 and `exec/sandbox-runtime.ts`
      448). Three claims mutated one at a time. All three SURVIVED, and
      the file is now the richest single haul of the arc — which is the
      thesis of 427 holding, because watch is where a claim's halves
      are furthest apart: a helper in one place, the loop that asks it
      in another, and a container whose watcher mode is neither of the
      two the comments were written about.
      (a) A first sighting is a change only if the path moved since the
      arm. `modifiedBefore` is pinned as a FUNCTION in
      `watch-rules.test.ts` — three cases and an unreadable path — and
      the loop's one call to it was pinned by nothing: dropping the
      whole branch (`return false`, the pre-2026-09-11 "a first sighting
      always re-runs") passes the entire repo. That is the defect the
      macOS flake of 2026-09-11 was, exactly: FSEvents hands a fresh
      stream what landed just before it started, so the initial run's
      own writes re-ran it.
      (b) `judge` evaluates `sameState(p)` BEFORE it tests whether a
      winner has been picked, and the order is the whole point:
      `sameState` is what RECORDS a path's state, so every path a
      judgement saw must be recorded even though only the first change
      names the cycle.
      Reversing the operands short-circuits after the winner. Nothing
      in the repo noticed, and the consequence is the M8 rule ("the
      same bytes are not a change") failing for any path that arrived
      in a BATCH: the other nineteen of a `git checkout` are left
      unjudged, and each one's next event is a first sighting stamped
      after the arm. The line carried no comment at all; it has one now.
      (c) `armWatcher` drops an event naming the watched directory
      itself (`''`, `'.'`) and one with no filename (`null`). Removing
      either guard passes: no e2e row can deliver them on a host whose
      probe never lands (this container polls), and the fake-`fs.watch`
      seam that could delivered only the probe.
      Pinned: (a) as an e2e pair — two files that existed before the
      arm, the SAME operation (`utimes`) on both, one stamped an hour
      before the arm and one after, asserting no cycle then exactly one;
      red 3/3 under the mutation. (b) on the existing `git checkout`
      row, by rewriting all twenty files with their own bytes (at most
      one can be the recorded winner) and requiring the cycle count to
      hold. (c) through the fake watcher, delivering `''`, `'.'`, `null`
      and one real name and asserting the caller sees the exact set
      `['src/a.ts']`.
      Four files swept now (427, 447, 448, 449): ten claims, five
      finds, five refutations.

450.  DONE (2026-09-20, the gate's own flapper turned out to be a real
      race, and my first two theories about it were both wrong).
      The `sandbox-runtime.unsafe` row "a persistent task whose literal
      write grant meant a directory" had gone red three times in a day,
      each time passing alone and on a re-run, and each time it cost an
      investigation. It is the instrument the whole sweep method reads,
      so it was worth root-causing rather than re-running.
      REFUTED first: not the row's `timeout: 5000` against a loaded box.
      The failing run took 117 ms, not five seconds. Reproduced under a
      real parallel gate (1 red in 8) and read the actual output: the
      task RAN, its own `mkdir` refused with the words `File exists`,
      and the hint that exists to explain exactly that message was
      absent.
      REFUTED second: the union in `execute-task` that a comment dated
      the same morning says closes this. It does not. A failed
      persistent task has two askers for the placeholder sweep — the
      child's exit handler and the readiness failure that prints the
      hint — and the union covers an exit handler that FINISHED. One
      still between its `rm` and its return has published nothing yet,
      and the readiness path's own second sweep finds the file already
      gone, so BOTH lists are empty and the hint is lost. The test row
      that pins the second-sweep property even ended "execute-task now
      reports the union of both sweeps", which is a comment claiming a
      guarantee the code lacked.
      Proven, not argued: delaying each side in turn (a sweep that lags
      between its `rm` and its return, and a readiness path that starts
      late) makes it red 3 of 3. Note which interleaving actually loses
      it — two raw sweeps started TOGETHER both stat before either
      removes, so they agree; a control asserting they disagree failed,
      and rightly. It is the asker that arrives after the first `rm`.
      Fixed by sharing ONE sweep: `placeholderSweeper` memoizes the
      promise, so the answer no longer depends on who asked first.
      Green 5 of 5 under the exact interleaving that was red. Pinned by
      a row that asks the shared sweeper concurrently AND after it has
      resolved, with the existing second-sweep row as its control; red
      when the memo is removed.

451.  DONE (2026-09-20, the pair `cache/inputs.ts` + `cache/git-inputs.ts`
      — glob resolution and the git enumeration it trusts, two halves by
      construction — and it found a STALE HIT, the worst failure class
      this tool has). Three claims mutated one at a time.
      (a) SURVIVED, and here the code was right while the test was
      missing. `parseLsFilesOutput` flags a path whose `ls-files -v`
      letter is `S` OR lowercase, because both mean git has stopped
      looking at the worktree file. Dropping only the LOWERCASE half
      passes the whole repo: `S` is skip-worktree, which a stale-hit row
      already drives, and lowercase is `--assume-unchanged`, which
      nothing drove. Probed git directly rather than trusting the
      comment — assume-unchanged prints `h`, skip-worktree prints `S`,
      and after an edit BOTH are silent in `git status --porcelain`, so
      the OID stays trusted while the bytes have changed. Pinned as the
      sibling of the skip-worktree row.
      (b) CAUGHT: disabling the `core.autocrlf` step of the clean-filter
      gate fails a row named, exactly, "core.autocrlf alone is enough to
      distrust index OIDs". A refutation that cost one run.
      (c) SURVIVED, and it is a real defect, reproduced on the real CLI.
      The gate that decides whether to ask `git check-attr` looked for a
      `.gitattributes` among the files the enumeration LISTED — and a
      scoped run lists the project dirs alone (`gitPathspecs`, a pure
      perf optimisation). A workspace-root `.gitattributes`, which is
      where a monorepo puts it, is therefore never seen, the gate reads
      "no attributes anywhere", and every filtered OID stays trusted.
      Measured on one fixture, one edit, CRLF→LF under `* text=auto`:
      `--all` (pathspec `.`) is a MISS and correct, while `--filter app`
      reports up-to-date and replays the old byte count. Two halves in
      different functions, one of them a perf decision silently deciding
      a correctness one — the arc's own thesis, and the first time it
      has landed on cache correctness.
      Fixed by walking directories instead of the file list:
      `attributesAbove` stats `.gitattributes` from each pathspec up to
      the repo root, bounded by depth and project count rather than file
      count, which is what the gate's cost rule actually cares about.
      Pinned with both arms in one row, the unscoped one as the control
      that was correct all along; red under the mutation, and each of
      the two new rows catches only its own.

452.  DONE (2026-09-20, the trim item 373's convention puts at forty).
      With this entry the loop stood at forty, 413–452, so items
      413–432 moved whole to
      `docs/history/2026-09-improvement-loop-413-432.md` and the loop
      keeps 433–452. A PREFIX again, for item 373's reason: the
      formatter renumbers an ordered list sequentially, so a cut from
      the middle renumbers every entry below it and silently breaks the
      cross-references in this file and in the test comments that cite
      item numbers. Counted before writing anything out: twenty in the
      cut, twenty left (nineteen plus this entry), twenty in the new
      file; eleven history heads and this file's own record paragraph
      repointed; handoff 14an moved to the next-log and 14ap takes its
      place beside 14ao.
      The head repointing was one literal clause this time, and that is
      432's work paying off rather than luck. 432 found the pointer
      sentence in THREE spellings and normalised all ten as it went, so
      "items 413 onward continue in" now reads identically everywhere
      and a single words-based match covers every file. The dry run
      still ran first and still refused-or-proceeded on a count of
      exactly one per file — the assertion is what makes the uniformity
      a fact rather than an assumption, and it is cheap enough to keep
      even when it is expected to pass.

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
    394, 400, 403, 409, 412, 419, 426 and 432 (14–14an) are in
    `docs/history/2026-09-status-next-log.md`; 14ap below is the
    current one, and 14ao above it is the one before.

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
Next: the loop holds 413–448, so the trim is due at 452. For work, the
shape that has paid every time in this arc is a claim whose halves live
apart. Still untried: `vx watch`'s cycle against the run's admission
dedup — REFUTED in 446, and 434 had already taken the pair proper —
and the sandbox's grants against what `cache.outputs` declares, which
428 touched from the read side only and 433 pinned from the derive
side. And the shape
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

14ap. **Handoff after item 452 (2026-09-20).** Eleven items since 14ao,
and the arc has one shape running through all of them: the correctness
sweep, and the thesis 427 left behind about WHERE it pays.
442–446 finished the halves-apart query on the three path rules and
then retired it, honestly — 446 pointed the same question at the
sibling packages and came back mostly refuting, so the query stopped
being the default.
447–449 revived the method on the three large files Next 8(d) named
and 427 had not taken: `orchestrator/run.ts`, `exec/sandbox-runtime.ts`
and `cli/watch.ts`. Ten claims, five finds, five refutations, and
`watch.ts` alone gave three — the richest single file of the arc, which
is the thesis holding rather than luck, because watch is where a
helper and the loop that asks it sit furthest apart. With `cache.ts`
(427's zero) that closes 8(d)'s four.
450 and 451 are the two that matter most, and neither came from a line
count. 450 root-caused the gate's OWN flapper instead of re-running it,
and both my theories were wrong before the third was right: a
two-asker race on the placeholder sweep where the union that was
supposed to close it only covers an asker that FINISHED. 451 took the
`inputs.ts` + `git-inputs.ts` pair and found a STALE HIT — a scoped run
lists only the project dirs, so a workspace-root `.gitattributes` was
invisible to the gate that decides whether to ask `git check-attr`, and
`--filter app` replayed an artifact the same fixture got right under
`--all`. A perf decision in one function silently deciding correctness
in another.
What to carry, beyond the method itself. First: pick the next target by
CLAIM DENSITY, not by line count — every find since 441 came from two
halves in different files or stages, and the two largest came from a
flaky test and a pair, not from a big file. Second: probe the tool
rather than trust a comment about it. 451(a) turned on running `git
ls-files -v` and reading the letters (`h` for assume-unchanged, `S` for
skip-worktree) instead of believing the sentence next to the code, and
the untested half was the one the sentence covered least.
UNRESOLVED, and recorded as unresolved rather than explained: main's
push run for `05d428a` failed one task of 44 in the Linux job while the
identical tree was green on two PR runs. The task's NAME was never
obtained — the log tail did not reach its block and the signed blob URL
is refused by this container's egress proxy — so the cause is unknown.
450's race fits the shape (red under parallel load, green alone) but
that is a guess, and a guess is not a cause. If it recurs, get the name
with `get_job_logs` and `failed_only` before theorising.
NEXT, in order: the two `sweepPlaceholders` call sites on
`execute-task.ts`'s ONE-SHOT path (~588, ~596), which 450 did not
touch and which may carry the same two-asker shape; then
`workspace/config-eval.ts` + `orchestrator/projects.ts`, the staged
load every reader shares. `attributesAbove` has no worktree or
submodule fixture either — it derives the repo root from `git
rev-parse --git-dir` and stops at the filesystem root, which is
untested. Never end with "what next?".

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
