# Shipped, 2026-09 — improvement-loop items 433–452

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
`2026-09-improvement-loop-393-412.md`, items 413–432 in
`2026-09-improvement-loop-413-432.md`; items 453 onward continue in
`docs/STATUS.md`.

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
