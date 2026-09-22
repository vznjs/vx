# Shipped, 2026-09 — improvement-loop items 533–552

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
`2026-09-improvement-loop-493-512.md`, items 513–532 in
`2026-09-improvement-loop-513-532.md`; items 553 onward continue in
`docs/STATUS.md`.

533.  DONE (2026-09-21, `config-schema.ts`'s TYPO GUARD — the
      `assertKnownFields` call at every object level of a config, and
      the field sets behind them. 15 mutations, one per call site plus
      the array branch and the self-hint guard. ALL FIFTEEN CAUGHT: a
      complete zero-yield report, and the item's finding is a bug in my
      own driver rather than anything in the file.
      A CRASHED RUN IS A SILENT PASS. The first sweep reported six
      survivors, which would have read as "the typo guard is unheld at
      five of thirteen levels". Every one of those six was a `bun test`
      that PANICKED — the same SIGILL that makes shard-9 flap — and a
      panicking run prints no failing row, so a driver counting
      `(fail)` lines scores the crash as a survivor. Eight of fifteen
      runs crashed; the combined five-file invocation is what invites
      it. Fixed by running one file per invocation and requiring a
      summary line from each, with a missing one reported INCONCLUSIVE
      rather than passed. Re-swept: fifteen of fifteen caught. The
      lesson is CLAUDE.md's own "a skip is a silent pass" wearing a
      different hat, and it now sits beside it.
      WHAT THE FILE ACTUALLY HAS, AND IT IS THE BEST-BUILT GUARD IN
      THE REPO. `schema-unknown-keys.test.ts` GENERATES one row per
      object level by walking a full config, and then pins the walk
      itself: a meta-row reads `config-schema.ts`, extracts every
      `assertKnownFields` template suffix, and fails if any level the
      schema guards is missing from the walk. So a level added to the
      schema and not to the fixture cannot pass unnoticed — the exact
      hole that "one fixture per member" keeps finding elsewhere,
      already closed here, and closed against the SOURCE rather than
      against a list someone maintains.
      The self-hint guard has its own row too, named for it: `nearest`
      never offers the name it was given, because an exact match is not
      a hint.

534.  DONE (2026-09-21, `orchestrator/task-hash.ts`'s KEY ASSEMBLY — what
      is BUILT into the `CacheKeyInput`, as distinct from 505's fold of
      it. 19 mutations, fourteen caught, five survivors, four real, four
      rows. Picked because every cache key vx produces is assembled
      here and 505 took only the fold and the config projection).
      THE PATTERN AGAIN, TWICE, AND BOTH TIMES THE SAME SHAPE: a rule
      whose PROJECT-level copy is pinned end-to-end and whose
      WORKSPACE-level copy arrived later with none of it.
      A task's own `cache.outputs.workspaceFiles` are excluded from its
      own workspace inputs — otherwise it folds its own generated file
      and its key moves after every run, so it never hits again. The
      exclusion is held, by a row that calls `resolveInputs` with
      `ownWorkspaceOutputs` itself. What nothing held is the WIRE:
      `task-hash` passing `cache.outputs.workspaceFiles` down to it.
      Hand it `[]` there and the exclusion is perfect and unreachable.
      The project-level twin of the same law fails 22 rows.
      The new row goes through `computeTaskHash`, with a control on a
      DIFFERENT workspace file that must still move the key — or the
      assertion would pass equally on a task that reads no workspace
      files at all.
      THE SECOND COPY IS ALSO WHERE A PIN STOPS SHORT. `task-hash`
      merges the workspace-wide OID partition into the project's for a
      task declaring `inputs.workspaceFiles`. A row pins which map WINS
      on a path present in both — and by construction it still passes
      when the merge is deleted outright, because its path is in the
      project map too. What the merge exists for is a path only the
      workspace map has. Measured before claiming: deleting it costs no
      correctness (identical key, `c915bbb282ae0b1c` both ways — the
      fallback recomputes the same blob OID from the worktree) and one
      `hashFile` per shared file, on the warm path the partition was
      added to make free. The row supplies a workspace-only OID and
      asserts it is the value that FOLDS.
      THE EXECUTOR INPUT SET, which `describeTaskInputs` builds and only
      a remote executor reads, so a wrong answer is invisible here. A
      workspace output's index row reads `workspace-outputs/<path from
the root>`: the prefix is a STORAGE discriminator and the path
      behind it is already workspace-relative, while a project output's
      row is project-relative and must be rebased. Treat the two alike
      and a worker is handed `proj/workspace-outputs/shared/…`, a file
      that exists nowhere, so it stages nothing and the task runs
      without the upstream output it declared a dependency on. The row
      carries BOTH namespaces from one producer, so it cannot pass by
      treating every path as workspace-relative.
      And the list's ORDER, which the docblock says is independent of
      declaration order "and any action digest derived from it" —
      unheld, so every reordering of a `dependsOn` array was a fresh
      remote action. Asserting sortedness alone passes half the time on
      two members; the row asserts that BOTH declaration orders produce
      the SAME list, which cannot.
      MEASURED EQUIVALENT, and this one is a no-op by construction:
      `describeTaskInputs` sorts `input.inputFiles`, and every producer
      of that list already sorted it (`inputs.ts` lines 179, 423, 574).
      Defensive normalisation at a seam, with nothing left for a row to
      catch — so none was written.
      THE SUITE LIST IS A FIXTURE, for the fourth item running. Three
      of the nine pre-check survivors — the project-boundary wiring, the
      group graft and its expansion — were caught outright by the whole
      suite, in `execute-task.test.ts` and `orchestrator-run.test.ts`,
      neither of which names a single symbol from the region.
      No source change.

535.  DONE (2026-09-21, `orchestrator/prepare.ts` — the decisions made
      ONCE per run that every task then inherits: scope, the fingerprint
      every key folds, the cache dir, frozen mode, boundary geometry,
      the cache seam and the two error paths. 20 mutations, fourteen
      caught, six survivors, ONE real, one row. Never swept; one passing
      mention in STATUS's whole history).
      A SKIPPED ROW IS A SILENT PASS IN A SWEEP, and that is this item's
      finding — 533's lesson in a second costume, found the same way.
      `no-assert-writable` (deleting the `localCache.assertWritable()`
      that refuses a cache directory this user cannot write) reported
      SURVIVED. It is not a survivor: the row that catches it is
      `describe.skipIf(skipAsRoot(...))` in
      `cache-dir-selection.test.ts`, this container runs as uid 0, and
      root bypasses the permission bit. `bun test` said `4 skip` in a
      summary the driver never read — in all twenty runs.
      ITEM 481 FOUND THIS EXACT HOLE FROM THE OTHER SIDE and built the
      fix: `VX_REQUIRE_NONROOT=1`, which CI sets, so the row binds where
      the merge is gated. What had no fix was the SWEEP, which never set
      it and never counted skips. The verdict script now sums ` N skip`
      and reports a partial verdict; a region whose rows skip here is
      INCONCLUSIVE on this machine, never a survivor. The rule sits in
      CLAUDE.md beside the crashed-run one.
      Verdicting it properly needs a non-root user; creating one in this
      container was refused, so it stays INCONCLUSIVE rather than
      worked around. CI verdicts it on every push.
      THE ONE REAL HOLE is the handle-hygiene PAIR, the same two-copies
      shape as 534. The local cache opens BEFORE the configs load,
      because it is where their cached evaluations live, so both throw
      paths between the open and the return close it. The cache-plugin
      copy has a row named for it. The config copy, thirty lines
      earlier, with the same one-line body and the same comment, had
      none — delete it and the suite stays green. A stranded SQLite
      handle in a process that keeps running (`vx watch`, an editor
      plugin, a daemon) meets a busy lock on the next open. The new row
      catches only its own copy, and the old row only its own.
      THREE EQUIVALENCES, each measured rather than argued.
      The git enumeration's `usesWorkspaceInputs` flag: with it forced
      false, a warm build still HIT the entry the pristine build saved
      (identical key), and editing the shared workspace file still
      MISSED. It is a pure up-front-enumeration optimisation — the
      on-demand `runGitLsFiles` fallback resolves the same set, and the
      lost OID merge is what 534 measured as one `hashFile` per file.
      The config-eval cache keyed on `unclaimed` instead of `all`: the
      only delta between the two digests is the files a `fingerprint`
      plugin claims, and a CACHEABLE config cannot read one. Non-relative
      imports beyond `@vzn/vx` are refused, an impure config is never
      stored, and the `project` stage that could read a lockfile runs
      AFTER the cache on the value it returned, so nothing lockfile-derived
      is ever stored. The `all` keying re-evaluates every config on a
      lockfile edit for no correctness gain today — worth keeping as the
      safe side, but the comment's reason ("a config may import a
      dependency") describes something the deny-list refuses.
      The candidate filter: unreachable from the CLI. `cli/select.ts`
      refuses an unmatched filter by name, every project it CAN name is
      loaded (a config-less one gets an empty-task entry rather than
      being absent), and `declaresTask` answers false for an unknown
      name anyway. Only a library caller hand-passing a name that does
      not exist sees a difference, and only in which message prints.
      And the early-git predicate's `indexOf('#') <= 0`: `#task` is
      refused by `resolveRunOptions` before it can reach here, and even
      if it did, `['.']` is a superset partitioned by project dir.
      No source change.

536.  DONE (2026-09-21, `orchestrator/plugin-host.ts`'s CAPABILITY GATE —
      what a plugin must hand back for core to run it. Never swept; zero
      mentions in STATUS's whole history. 25 mutations, seven caught by
      the region's suites, and the whole-suite step then took the fifteen
      list members back. Two rows, sixteen assertions).
      THE GUARD THAT LISTS MEMBERS, for the fifth time (518, 526, 531, 532) and in its sharpest form yet. `CACHE_LAYER_METHODS` is
      fifteen names, and the comment above it records WHY: it was
      widened from five after a real defect, because "a layer with
      those five passed and died at its first hit inside
      restoreOutputs".
      Nothing holds its CONTENTS. The one fixture exercising the
      refusal is `{ nope: true }`, missing everything, and it builds
      its expected message by mapping over `CACHE_LAYER_METHODS`
      itself — so it agrees with whatever the list says. The only
      witness to a change is a DOC-DRIFT row asserting the plugins
      guide's stated method COUNT equals the list's length.
      A COUNT IS NOT THE CONTRACT. Dropping any member is caught, and
      always by that same row (verdicted whole-suite at both ends of
      the list: key, get, has, prefetch, close — one new failure each,
      the doc row, and the mechanism is the length). Keep the count and
      the requirement can be anything: duplicate an entry in place of
      `prune` and a layer with no `prune()` is accepted, then dies
      inside prune — the 2026 defect returning by the one door left
      open. Three such swaps, all SURVIVED the whole suite.
      A SECOND HOLE, independent: the non-object branch. `resolveCache`
      skips only `undefined`, so `null` reaches the gate; without that
      branch the filter indexes `null` and throws a TypeError naming
      neither plugin nor hook — the exact failure the gate replaced.
      Also survived the whole suite.
      THE FIX IS 533'S SHAPE: a table generated from the SOURCE OF
      TRUTH. The members are parsed out of the `CacheLayer` interface
      in `cache/layer.ts` (required = declared without `?`), one
      fixture per member withholds exactly that one, and a meta-row
      asserts the constant equals that set in both directions and holds
      no duplicate.
      AND I WROTE THE TAUTOLOGY MYSELF FIRST. My table generated its
      rows from `CACHE_LAYER_METHODS`, so it shrank with the list: the
      differential run reported 44 pass and NO failure. Caught only
      because a row that cannot fail was the thing I was there to find.
      The rule is in CLAUDE.md — generate from the source of truth, and
      compare a pinned message with `toBe`, since `toThrow` matches a
      substring and `missing key(), key()` satisfies `missing key()`.
      MEASURED, and the reason the list is worth this: the local floor
      and the chain are already held hard — dropping core's cache tail
      fails 40 rows, always chaining a single layer fails 42, dropping
      the local executor tail fails 17. The gate is the one part of
      this file that was trusted rather than tested.
      No source change.

537.  DONE (2026-09-21, `orchestrator/sandbox-request.ts` — the sandbox
      request assembly: the run-wide union, the enforcement anchors, the
      dependency grants, and the placeholder files vx creates so a bind
      has something to mount. Three passing STATUS mentions, never its
      own item. 24 mutations, eleven caught, THIRTEEN survivors, all
      confirmed whole-suite — the largest survivor set of the series.
      Six closed by five rows).
      THE SWEEP DELETES WHAT THE TASK WROTE. `sweepPlaceholders` takes
      back only a placeholder that is still a file, still EMPTY, and
      whose mtime is untouched — three conditions ANDed. The row
      covering it writes `bytes`, which moves the size AND the mtime, so
      either guard alone still saves the file and neither has a witness.
      Both uncovered shapes are ordinary producers. A task that writes an
      EMPTY file (`touch dist/.keep`, a marker, an empty
      `.tsbuildinfo`) moves only the mtime. A task that writes content
      and RESTORES the mtime — `cp -p`, `tar -x`, `unzip`,
      `rsync --times`, any SOURCE_DATE_EPOCH generator — moves only the
      size. That is the same producer class CLAUDE.md already names for
      the file-hash memo's ctime rule, so this repo has been bitten by
      these tools once already. Either way vx removes the task's real
      output and reports it as litter it took back.
      The mtime row needs care: `mtimeMs` carries sub-millisecond
      precision a `Date` cannot round-trip, so the file is normalised to
      a whole millisecond and the record taken FROM that. My first
      version restored to the raw value, missed by a fraction, and the
      sweep skipped the file for the wrong reason — the precondition is
      asserted so that can only fail loudly.
      THE SIBLING PREFIX, a third time (520 on sandbox write grants, 527
      on static prefixes). A workspace dependency is a symlink in
      `node_modules` and its target is granted, unless it is already
      inside a granted directory. That test is a path comparison, and
      `node_modules-extra` is not inside `node_modules`: without the
      separator the prefix test says it is, and the sibling a task
      imports is silently not granted. The scoped shape had no fixture
      either — a package manager writes `node_modules/@acme/pkg` one
      level deeper, and the scan takes that step explicitly.
      THE DEDUP NEEDS A CANONICAL ROOT, found by CI on darwin only and
      then reproduced on Linux under a symlinked root: `linkedDeps`
      realpaths a link's TARGET and compares it against the granted
      directories AS GIVEN, so where the project path is not canonical —
      macOS's `/var/folders` is a symlink to `/private/var` — nothing is
      ever recognised as already inside a granted directory and every
      link is granted redundantly. Harmless for enforcement, since the
      parent is granted anyway, but it makes the dedup unobservable, so
      the fixture takes a canonical root and the control tests the dedup
      rather than the platform.
      THE WILDCARD CLASS IS ITSELF A LIST. `/[*?[\]]/` decides whether a
      grant is a glob or a literal path to bind as an empty file, and
      every fixture spells `*` — including every `**`, which is why a
      fixture must carry `?` or `[` and NO star to reach the gap at all.
      My first attempt used `out?/**`, which still holds a star and
      proved nothing. `out?` alone is bound as a literal file named
      `out?`: the 2026-09-16 trap by a spelling no row covered.
      A SURFACE WITH NO WITNESS OF ANY KIND, and this is the item's
      second finding. `prepareSandbox` computes a RUN-WIDE union —
      the domain allowlist, and whether the all-or-nothing unix-socket
      filter is lifted — and hands it to SRT's `initialize()`. Nothing
      asserts what that call receives. Dropping the domain union
      entirely, narrowing the socket lift to `unixSockets: true` alone,
      and widening it so an EMPTY list lifts the filter for the whole
      run all survive untouched. The last is the security-relevant
      direction: a user writing `unixSockets: []` to mean "none" would
      get "all". A row needs the live `initialize()` call observed, which
      no suite does today.
      MEASURED EQUIVALENT: returning an armer for a run with no
      sandboxed task. The armer is lazy and `arm()` is only called by a
      sandboxed task, so `armed` — the one reader, gating `resetSandbox`
      at `run.ts:853` — stays false either way.
      INCONCLUSIVE ON THIS MACHINE, reported as 535 requires rather than
      as a survivor: `weakerWhenNested` is nested seatbelt, macOS only,
      and its describe is the single skip the classifier flagged on all
      24 runs here.
      No source change.

538.  DONE (2026-09-21, the RUN-WIDE SANDBOX UNION — 537's unfinished
      business. That item found a surface with no witness of any kind:
      `prepareSandbox` folds every sandboxed task into the one allowlist
      SRT's `initialize()` is armed with, and three separate widenings of
      it survived a whole-suite sweep. This closes it. SOURCE CHANGE,
      pure motion).
      THE SEAM: `sandboxRunUnion(nodes)` returns
      `{ domains, unixSockets, weakerNested } | null` and `prepareSandbox`
      destructures it. Same shape as 528's `locallyPlaced` extraction —
      the fold was unobservable only because it lived inside a closure
      whose one exit is a live runtime call. Behaviour is identical; the
      duplicate "is any task sandboxed" filter goes away with it, since
      `null` now carries that answer.
      SEVEN MUTATIONS, ALL CAUGHT by six rows, including the two 537 had
      to leave open — `weakerNested` was INCONCLUSIVE there (macOS-only
      nested seatbelt, the single skip on all 24 runs) and is now pinned
      on every platform as the reduction it is, and the empty-run gate
      was measured-equivalent but unpinned.
      THE ROW I DID NOT EXPECT TO WRITE. `network: true` contributes NO
      domain, and the naive fold adds `*`. I read that as a defect and
      went looking: `sandbox-binds` really does map per-task
      `network: true` to `allowedDomains: ['*']`, and the run-wide fold
      really does skip it. The docs settle it — "`network: true` skips
      the proxy entirely" — so the omission is deliberate and folding it
      in would hand every OTHER task in the run an allowlist matching
      everything. The suspicion was refuted, and the refutation is the
      row: nothing anywhere spelled `network: true`, so the dangerous
      "fix" was one plausible reading away.
      THE SECURITY DIRECTION, from 537: `unixSockets: []` means NONE.
      SRT's `socket(AF_UNIX)` filter is all-or-nothing and read once at
      `initialize()`, so reading an empty array as "a list was given,
      allow all" lifts it for every task in the run. Pinned alongside
      `true`, a non-empty list, a `localBinding` port list on Linux, and
      the one-task-asking-is-enough case.
      ALSO PINNED: domains are the UNION across tasks and deduped, not
      the first task's — a fold that kept one task's list leaves every
      other task filtered against someone else's allowlist.
      Docs: the module page carries the new surface, and the interface
      joins `module-shape-drift`'s list so its fields stay honest.

539.  DONE (2026-09-21, `workspace/config-imports.ts` — the third
      `changed file → project` channel for `--affected`, and the guard
      that refuses a config's bare import before Bun can download it.
      ZERO mentions in STATUS's whole history. 23 mutations, eight
      caught, FIFTEEN survivors, all confirmed whole-suite. Seven closed
      by seven rows).
      A HAZARD DOCUMENTED TWICE AND TESTED NEVER. Two docblocks warn
      that `Bun.resolveSync` hands back REALPATH'D targets, so a raw
      root "silently fails every containment check and the scan reports
      no imports — indistinguishable from a clean tree", and that on
      darwin a workspace under `os.tmpdir()` lives at `/var/folders/…`
      while its realpath is `/private/var/…`. All THREE `realpath` calls
      could be deleted without a single row moving: on Linux a temp dir
      IS canonical, so every fixture normalised the difference away.
      A root reached through a SYMLINK reproduces the darwin shape on
      any platform — the trick 537's macOS failure taught, applied the
      other way round — and turns three inconclusive mutations into
      three rows. Without the root's realpath a changed preset selects
      NOTHING; without the config's, the config changing selects
      nothing; without the directory index's, every file looks unowned
      and the walk descends through all of them.
      THE SILENT ONE IS THE LOADER. It is chosen from the extension,
      and every fixture's `.ts` config happens to be valid JavaScript
      too, so the choice never mattered to any row. Scanning TS-only
      syntax with the js loader THROWS, `scanLocalImports` catches it
      and returns no edges, and a config that imports a changed preset
      contributes nothing at all: `--affected` reports a clean tree and
      the task that reads the edited preset never runs. Measured, not
      assumed — `new Bun.Transpiler({loader:'js'}).scanImports` on a
      type annotation throws "Failed to scan imports" while the ts
      loader returns the specifier. Reachable by nothing more exotic
      than `const v: number = p`.
      A FIXTURE THAT CANNOT SEPARATE TWO LOOKUPS. The bare-import row
      spells `@acme/preset` and provides it, so it cannot tell a lookup
      of the PACKAGE from a lookup of its SCOPE: wherever any `@acme/*`
      is installed, `node_modules/@acme` exists too and both answer
      "provided". `@acme/missing` beside an installed `@acme/present`
      is the case that separates them, and it is the one that matters —
      a typo or a half-finished install, handed to Bun to fetch.
      THE PRE-FILTER MUST NOT BE NARROWER THAN THE SCAN.
      `hasBareCandidate` is textual and a source it rejects is never
      scanned at all. Its regex spells three forms — `from`, `import`
      and `require(` — and every fixture used the first two, so
      dropping `require` cost nothing any row could see while making a
      CommonJS-style config's missing import invisible: the guard
      returns `[]` and the download happens. Same shape for the
      `@vzn/vx/` SUBPATH exemption, served by the core alias inside the
      compiled binary where there is no `node_modules` to find it in.
      MEASURED UNREACHABLE, by enumerating the ONE caller: the
      workspace-root prefix test without its separator (the
      sibling-prefix mistake a fourth time — 520, 527, 537) changes
      nothing, because `affected.ts` passes `changed` straight from git
      as workspace-relative paths, and an edge recorded for a file
      outside the root can only fire if that file appears in `changed`.
      MEASURED EQUIVALENT: the textual fast path (same answer, slower
      without it), the three early exits and the `skip` filter — all
      perf, all reached only after the answer is already determined.
      The `node_modules` guard is a blowup guard: without it the walk
      descends a package's whole import graph, which costs wall time
      rather than correctness, since git does not track `node_modules`.
      No source change.

540.  DONE (2026-09-21, `workspace/project-loader.ts` — how a config is
      loaded, refused and its failure classified. Never swept. 19
      mutations, fourteen caught, four survivors; three closed by three
      rows and one measured unreachable. A ONE-LINE SOURCE FIX).
      WORTH SAYING FIRST: this file is the best-held of the recent
      sweeps. The default-export shape, the error classifier's two
      names, its `instanceof`-free matching, the install hint, the
      line/column and the wire to the bare-import refusal are all
      pinned, several of them by rows written for item 517's defects.
      THE LOADER, AGAIN, ONE FILE OVER. `refuseUnprovidedImports` picks
      its loader with `/\.[cm]?ts$/`, and `vx.config.mts` is a
      DISCOVERED config name. Every fixture spells `.mjs` or `.ts`, so
      the `[cm]?` had no witness — and losing it does not merely
      mislabel the file, it turns the guard OFF: scanning TS syntax with
      the js loader throws, `unprovidedBareImports` catches that and
      reports nothing missing, and the config goes to Bun, which
      auto-installs the package from the registry. The download the
      guard exists to prevent, reachable by renaming a config. 539 found
      the same "loader from the extension" rule unheld in
      `configImportOwners`; this is its second copy.
      A ROW THAT FAILED ON PRISTINE AND TAUGHT ME THE MECHANISM. I set
      out to pin that `fresh` re-evaluates under a changed environment,
      because the docblock says the content-hash bust "would replay an
      evaluation made under earlier env values". It failed — and not by
      replaying: the second load returned `unset`. A REPEAT load in this
      process does not use the module cache at all, it re-evaluates in a
      WORKER. So the `fresh` UUID can never be observed: a first load
      imports a URL never seen before, and every later load bypasses the
      import entirely. Measured unreachable, and the row came out again
      rather than being bent to fit.
      THE FIX, one line and user-visible. The fallback arm of the
      `ResolveMessage` branch strips vx's own module-cache bust from
      Bun's message so "the user gets the file they wrote" — with
      `\S+`, which is greedy and ate the CLOSING QUOTE too, handing the
      user `from '/w/p/vx.config.ts` with no balancing quote. Every
      existing row matches the `Cannot find package '<x>'` form and
      never reaches that arm. Narrowed to `[^'"\s]*`; the row asserts
      the balanced message, and a second mutation restoring `\S+` fails
      it.
      ALSO PINNED: a `BuildMessage` whose `position.file` is the EMPTY
      string falls back to the config's own path, rather than telling
      the user the error is `(in :7:3)` — a location naming nothing.
      No `--frozen`, no `vx lock`: those paths are next.

541.  DONE (2026-09-21, `workspace/config-eval.ts` — the WORKER every
      repeat config load goes through, which item 540 discovered by
      accident when a row failed returning `unset`. 22 mutations,
      FOURTEEN caught, eight survivors, one row. A thin yield, and the
      reason is worth more than the row).
      THIS FILE IS THE BEST-HELD IN THE SERIES. Everything the header
      argues for has a witness: that a worker gets a fresh module
      registry (so a shared preset edit is not invisible — the defect it
      was written for), that ONE worker serves a whole concurrent round
      and is retired when the last load settles, that a config crosses
      back as JSON, that a broken config's NAME, MESSAGE, STACK and a
      transpile error's POSITION all survive the hop, that the env
      budget is clamped and its pattern anchored, and that the timer is
      cleared in a `finally` so a rejected evaluation leaves no orphan
      to kill an unrelated later round. Fourteen of twenty-two
      mutations die against the file's own two suites.
      THE ONE HOLE, and it is a FIXTURE that cannot witness its own row.
      A row already exists for the resolve on the way in, and its comment
      states the contract exactly: callers "are usually absolute;
      'usually' is not a contract". It builds its relative path with
      `path.relative` from the test's cwd to a temp dir, which comes out
      as four levels of dot-dot into `/tmp` — and THAT SHAPE SURVIVES
      THE BUG. The worker is an inline data URL (it has to be:
      `bun build --compile` does not embed a Worker entry point), so its
      base is one segment deep; four dot-dots climb past it to the root
      and the rest of the path reads correctly from there. Delete the
      resolve and the row still passes.
      The shape that separates them carries no dot-dot at all. With the
      process cwd set to the fixture root for the length of the call, a
      leading dot-slash name has nowhere to climb from and resolves
      against the data URL instead, failing with a path the user never
      typed. Measured both ways; the new row sits beside the old one and
      says why the old one cannot fail.
      SEVEN CLASSIFIED, none of them bent into a row.
      MEASURED EQUIVALENT: the `json === null` guard before `JSON.parse`
      — `JSON.parse(null)` coerces to `"null"` and returns `null`, so
      the guard is readability, not behaviour.
      DEFENSIVE AGAINST STATES THE FIXED WORKER SOURCE CANNOT PRODUCE:
      the `messageerror` and `onerror` handlers. Both exist so "every
      path off this worker must settle its pending promises", and the
      worker only ever posts JSON strings and primitives, so neither can
      be driven without replacing the worker source itself.
      BELT-AND-BRACES: the `pending.delete(id)` in the `finally` (the
      resolve path deletes on arrival and `rejectAll` clears the map),
      and `timer.unref()` (the same `finally` clears the timer on every
      exit, so it is only ever live during the await).
      NEEDS A WEDGED WORKER TO SEE: not terminating on timeout, which
      leaves the next round reusing the wedge.
      UNOBSERVABLE WITHOUT WAITING IT OUT: the 30-second DEFAULT budget.
      Its clamp and its anchored pattern are both held; only the number
      itself would need a thirty-second row to pin, which is not worth
      it — the docblock's argument that both ends break the feature is
      already carried by the two rows that do exist.

542.  DONE (2026-09-21, `workspace/lockfile.ts` — the `--frozen` trust
      boundary: what `vx lock` writes, what reads it back, and what a
      frozen run is allowed to believe. ZERO mentions in STATUS's whole
      history. 18 mutations, EIGHTEEN CAUGHT. A complete zero-yield
      report, and the first one whose finding is that a file is
      finished).
      THIS IS WHAT HELD LOOKS LIKE, and it is worth recording because
      the series keeps finding the opposite. Every guard has a row, and
      every row is NAMED FOR THE GUARD it holds — the failing row under
      each mutation reads like the mutation's own description. One row
      per member, thirteen of them across the read boundary alone, and
      not one shared witness doing double duty.
      THE TWO TRAPS THE SOURCE COMMENTS NAME BOTH HAVE ROWS, which is
      the part that matters most. `typeof [] === 'object'` and
      `[] !== null`, so an array sails through a naive shape check: a
      top-level array would be reported as "unsupported version
      undefined", a version diagnostic for a shape problem, and a
      `projects` ARRAY would be ACCEPTED outright because
      `Object.entries` walks it happily, yielding a project literally
      named "0" while `--frozen` looks up real names against a lock
      that declares none of them. The comments explain both; the rows
      are named "a top-level ARRAY is a SHAPE error, not a misread
      version" and "a `projects` ARRAY is refused rather than
      yielding…". A documented hazard WITH a row, for once.
      THE TRUST PATH'S TWO ARMS ARE SEPARATELY WITNESSED. `--frozen`
      refuses a project the lock does not know, AND refuses one whose
      entry points at a DIFFERENT config path — the second is the arm
      that would otherwise hand a project someone else's frozen config,
      and it has its own row rather than riding on the first.
      ALSO HELD: the lock is hand-editable, so the stored config is
      re-validated on the way out ("a lock cannot inject a broken
      config"); the version check refuses a STRING "1" as well as a
      wrong number; a missing lock returns null rather than throwing,
      which is what lets `--frozen` say its own sentence; and even the
      written FILE SHAPE — two-space indent, trailing newline — is
      pinned, because the file is committed and its diff is a contract.
      Nothing to add. The sweep's value here is the negative result:
      the highest-risk boundary in the config path is the best-tested
      file this series has opened.

543.  DONE (2026-09-21, `orchestrator/plugin-host.ts`'s PIPELINE STAGES
      — the four that shape the graph and the cache key, which 536 left
      when it took only the capability gate. 13 mutations plus one
      joint: five caught, two CAUGHT BY HANGING, six survivors, three
      rows).
      THE SAME TRAP 542 FOUND COVERED, HERE COVERED ON NEITHER ARM. The
      `key` stage refuses material that is not a record of strings, and
      its guard has three arms. One row exercises it, with ONE spelling
      — a string, which fails on the first arm — and its comment
      explains the defect it was written for: a plugin returning `'v22'`
      "used to fold parts named '0', '1', '2' into every key, silently
      and permanently".
      An ARRAY reaches that same fold by the spelling nobody spelled:
      `Object.entries` walks it happily and folds '0', '1', '2'. And
      `null` is an object too, so it sails past the first arm into
      `Object.entries(null)`, which THROWS a TypeError naming neither
      the plugin nor the stage — the internal-error failure `safe()`
      exists to replace, from the one return value that most looks like
      "no material". Item 542's `lockfile.ts` has a row for both arms of
      this exact `typeof [] === 'object'` trap; one file over, neither
      had one.
      THE SORT HAD NO WITNESS BECAUSE EVERY FIXTURE DECLARES ONE PLUGIN.
      Parts are sorted "so the fold is order-independent", and with a
      single contributor there is no order to be independent of. Without
      it the parts arrive in plugin-declaration order, so moving two
      plugins around in `vx.workspace.mjs` silently re-keys every task
      in the workspace — a full cold rebuild for an edit that changed no
      input. The row keys the same material both ways round, with a
      control that a different value still moves the key.
      CAUGHT BY HANGING IS NOT CAUGHT WELL, and it is this item's
      method finding. Deleting the graph stage's dangling-dep check or
      its cycle check does not redden a row: `plugin-pipeline.test.ts`
      NEVER TERMINATES. Measured — the file alone, with the cycle check
      gone, was killed at 90 seconds having printed nothing at all. The
      rows exist and they do notice; what they produce is a job timeout
      with no failing name, which in CI is indistinguishable from
      infrastructure. My own driver met the same thing from the other
      side: the first sweep run used a 400-second per-file bound against
      a six-second baseline and wedged for the whole tool timeout. A
      sweep needs a bound near the baseline, and a missing summary line
      has to be read as INCONCLUSIVE whether it came from a panic (533)
      or a hang.
      MEASURED EQUIVALENT, and it needed the JOINT mutation to settle.
      `applyKeyHooks` only sets `keyParts` when a plugin contributed
      something, and `Cache.key` carries the SAME `length > 0` guard, so
      removing either alone is invisible by construction. Removing BOTH
      folds a `plugin:0` section into every task's key — a silent
      workspace-wide key-domain shift, one cold rebuild for every user —
      and the whole suite still passes, because nothing pins an
      ABSOLUTE key. That is deliberate rather than missing: this
      project's rule is that a key-derivation change is self-healing and
      does NOT bump `CACHE_VERSION`, so a golden-key row would demand a
      bump the invariant says is unnecessary.
      TWO LEFT AS CLASSIFIED, both needing a second graph plugin no
      fixture declares: which plugin a graph violation is blamed on (the
      docblock chooses the LAST deliberately, and with one plugin first
      and last are the same), and running the post-stage check when no
      plugin declared `graph` at all, which is the zero-cost gate and
      costs only the walk.
544.  DONE (2026-09-21, `orchestrator/plugin-host.ts`'s REMAINING HOSTS
      — `claimedAffected`, `applyScheduleHooks`, `buildAdmission`,
      `teardownPlugins`: everything 536 and 543 left. 24 mutations:
      eleven caught, thirteen survivors, nine closed by nine rows, four
      classified. No source change).
      A HOST WITH NO WITNESS AT ALL, because every fixture enters by
      another door. `claimedAffected` is what stands between a real
      plugin's answer and `--affected`'s selection, and its whole shape
      guard could be DELETED with the suite green. The six rows in
      `affected.test.ts` about claim semantics hand `affectedProjects` a
      shim whose `affected` returns a `Set` directly — the host is wired
      in one file over, at `cli/select.ts`, so not one of them reaches
      it — and the single row that does go through it (the CLI end-to-end
      pin in `plugin-pipeline.test.ts`) exercises the happy path and
      "cannot tell". So: `null` and a number reached the fold's `for…of`
      and threw a TypeError naming neither plugin nor hook; a non-string
      element was added to the selection as a project; and a plugin that
      THREW in `affected` surfaced its raw error rather than `safe()`'s
      attributed sentence. Five rows, each asserting the exact message
      with `toBe`.
      A GUARD ARM CAN BE REFUSED BY ITS SIBLING, so measure which one
      fires before calling it unheld. The guard's explicit `typeof
answer === 'string'` arm — the one its docblock names, "a plugin
      returning 'all' cannot select the projects spelled a, l, l" — is
      belt-and-braces: a string is not an `'object'` either, so the
      second arm refuses it with the same sentence, and removing the
      string arm alone changes nothing. The row stays (it fails when the
      guard goes) and says so in its comment. Same shape in
      `applyScheduleHooks`: `typeof w !== 'number'` is redundant beside
      `!Number.isFinite(w)`, which does not coerce.
      ONLY AN EXPLICIT `false` REFUSES, and that strictness is what
      keeps the file's own promise ("the predicate is never the reason a
      task hangs") true for the likeliest plugin bug there is — a branch
      with no `return`. A truthiness test reads that `undefined` as a
      veto, and since nothing ever un-refuses a task, the run sits at
      zero running tasks until the job dies. The new row catches that
      mutation by its OWN 20-second timeout: a named failing row, not
      543's whole-file wedge, which is the difference a per-row timeout
      makes when the defect is a hang.
      THE TEARDOWN BUDGET IS PER PLUGIN and nothing pinned it. The
      docstring argues for it outright (plugins × bound: 3.0/6.0/9.0s,
      "deliberate rather than overlooked") because the bound is read
      INSIDE the loop. Sharing one budget across the loop does not merely
      hurry the last plugin: it reports a plugin that tore down perfectly
      well as having TIMED OUT — a warning about the wrong plugin, worse
      than no warning. The row hangs one plugin and gives the next a
      20 ms teardown against a 120 ms bound.
      ALSO CLOSED: `undefined` is the one non-Map the `schedule` stage
      must accept (a policy with nothing to say for this run), and every
      other non-Map is a hard error — the abstain path had no row; and
      `buildAdmission` returns `undefined` when no plugin answers, the
      one stage gate with NOTHING observable from a run (a predicate that
      admits everything and no predicate at all produce the same
      schedule, the same outcomes and the same absent `admissionHeldMs`),
      so it is witnessed by the one direct call in that file.
      TWO MEASURED EQUIVALENT BY TRACING THE CONSUMER, not by assertion.
      Dropping `schedule`'s `!nodes.has(id)` skip lets foreign ids into
      the priorities map, and they are never read: `run.ts` gates on
      `priorities.size > 0`, `mergePriorities` copies them, and
      `ReadyHeap` looks up only graph ids, so the order is identical.
      And `buildAdmission`'s `task === undefined → admit` is unreachable
      from its one call site — `run.ts` hands the SAME `nodes` map to
      the predicate and to `runGraph` — though the direction is the right
      one: refusing an unknown id would hang, admitting defers to the
      count limit.
545.  DONE (2026-09-21, `exec/executor.ts` — the per-task execution
      contract: what a plugin executor may resolve, and where a task is
      placed. Never swept. 17 mutations: seven caught, ten survivors,
      all ten closed by five rows. No source change).
      THE GUARD WRITTEN FOR A CRASH HAD NO ROW FOR THE FIELD THAT
      CRASHED. `assertExecuteResult` exists because a plugin that
      resolved `{}` met `res.violations` in core and surfaced as
      "internal error in <task>: TypeError" — vx's crash for the
      plugin's bug, named in its own docblock (2026-09-16). Its nine
      arms had ONE witness: an end-to-end row in
      `execute-task.test.ts` with `exitCode` missing. So `violations`
      itself — the field of the original crash — could be dropped from
      the guard with the suite green, and so could `durationMs`,
      `stdout`, `stderr`, the non-object arm, the `null` arm and all
      three `outputs` arms.
      Five rows now, one per arm and each named for it: the
      `violations` row asserts the WHOLE sentence (prefix and "a plugin
      bug, not a task failure" suffix included) and the rest the clause
      that varies, all with `toBe`. The deferred arms matter beyond
      diagnostics: core calls `materialize()` lazily and at most once,
      so a `deferred` handle without one loses a task's outputs under a
      green run.
      A CATCH BY COLLATERAL IS NOT A WITNESS. Making `outputs` REQUIRED
      reddened 44 rows across the cache suites — every ordinary result
      omits it — which says only that the suite runs, not that anything
      pins the rule. The control row now states it: `outputs` absent is
      what every executor resolved before deferral existed.
      `selectExecutor` IS FINISHED, the second such file after 542.
      All five placement mutations were caught by rows named for them:
      first-in-order wins, a `pinnedLocal` task is never offered to a
      `remote` executor (and the skip is keyed on `remote === true`, so
      an executor that declares nothing still takes it), `accepts()`
      decides and sees the placement, and an all-declining list throws
      rather than silently placing on the first.

546.  DONE (2026-09-21, `orchestrator/plan.ts` — what `--dry` and
      `--graph` predict. Never swept. 20 mutations: fourteen caught,
      six survivors, four closed by four rows, two classified. No
      source change).
      THE CRITICAL PATH TOOK THE LAST DEP, NOT THE LONGEST, and the
      diamond that guards it could not tell. `predictPlan` folds the
      MAX of its deps' distances over a Kahn order, and the fixture's
      join reads `a#left` (150) then `a#right` (300) — so "last wins"
      and "max" agree by accident of dep ORDER. Deps arrive sorted, so
      the case that separates them is the one where the expensive
      parent sorts FIRST: `heavy` before `light` predicts 930, and
      last-wins predicts 50. The new row keys both orders and gets the
      same wall.
      A GROUP'S PLANNED HASH had no witness either. It is
      `computeGroupHash(upstream)` — the same roll-up `execute-task.ts`
      uses — and a group that planned as an empty string would key
      every task under it differently from the run the plan claims to
      describe. The row moves a member's key and watches the group's
      follow, with a control that the same member key gives the same
      group hash.
      `download` MARKED EVERY TASK THE POLICY NAMED. The field is
      attached when `downloadOf(id)` says deferred, and `modeOf`
      answers eager and never for most tasks under
      `--download=toplevel` — ordinary answers, not absences. Matching
      "not undefined" would tell a user their outputs stay remote for
      tasks about to be written to disk, on the table and in `--json`
      alike. One row, three tasks, one per mode.
      AN EMPTY DOWNGRADE LIST IS NOT A REFUSAL, and `--json` prints the
      key whenever it is present, so an empty array would answer "did
      the gate refuse anything" with a shape that says yes.
      TWO CLASSIFIED. Attaching an undefined `executor` unconditionally
      is measured equivalent on BOTH surfaces: the table checks the
      field for undefined and the JSON builder spreads it
      conditionally, so an undefined-valued key never reaches either.
      And dropping the `byId.has(d)` filter in the Kahn pass changed
      nothing because no fixture — and no path we could construct —
      drops a task from the plan while keeping a dependent: the one
      production path that drops a key (an underivable
      `cache.inputs.runtime`) keeps BOTH the task and its dependent in
      the plan, with an empty hash each.

547.  DONE (2026-09-21, `orchestrator/projects.ts` — the staged config
      load every reader and every run shares. Never swept. 25
      mutations: ten caught, fifteen survivors, five closed by three
      rows, ten classified. No source change).
      A SKIP WRITTEN DOWN AS A SAVING IS ALSO AN ALIGNMENT. `withFile`
      leaves out a project the caller already staged, and its comment
      gives the reason as cost — no second evaluation, no second
      `project` stage. The other reason is not written anywhere: the
      round loop reads `loaded[next++]` for each project it did NOT
      skip, so an evaluated config belonging to a staged project shifts
      every later project onto its neighbour's config. Wrong tasks,
      wrong commands, wrong cache keys, under a green run. The witness
      needs the staged project FIRST in the round, so its entry is the
      one the next project would read; nothing in the suite had that
      shape, and the staged-once rows count `project`-stage calls, which
      the shift leaves untouched.
      Today's one caller stages every config-bearing project (the CLI's
      selection pass runs with scope `all`), so the misalignment is not
      reachable through it — the row pins the contract for the next
      caller, and the failure class it guards is the worst one this
      project has.
      A SWALLOWED PARSE ERROR IS A PROMISE ABOUT WHO REPORTS IT.
      `crossDepProjects` walks `dependsOn` for `pkg#task` targets and
      swallows a spec it cannot parse, because the graph builder reports
      it with the offending task's id in front. Rethrowing surfaces the
      same sentence stripped of the one thing that says where to fix it,
      from a load with no task to name. The comment says so; no row did,
      and the suite never grepped "Invalid dependency spec" at all.
      A READER IS NOT A RUN. `loadResolvedProjects` passes
      `closure: false` deliberately — `vx show`, `vx mcp` and an
      embedder asked about one project are answered about that project,
      where a run pulls the dependency closure in because `^task` needs
      it. Neither that nor "a package that wrote no config is not a
      project" had a witness; one row now pins both, with the unscoped
      control beside it.
      TEN CLASSIFIED, and eight of them are cost, not behaviour: the
      `config`-stage gate (an empty plugin list makes the call a no-op),
      both closure short-circuits (they exist to avoid building the
      package graph's transitive bitsets), the `#` fast path (a spec
      without one cannot parse as cross), the reader's eval cache (a
      stat instead of an evaluation) and its `cache.close()`. Pushing
      every parsed spec's project rather than only a `cross` one is
      measured equivalent: every `#`-bearing spec that parses IS cross,
      and the parser throws on the rest. And a staged project's
      cross-deps go unpulled without effect for the same reason the
      alignment bug hides — the only caller stages them all.

548.  DONE (2026-09-21, `cli/show.ts` — `vx show`: the workspace's live
      resolved configs, as a run would see them. Never swept. 28
      mutations: eighteen caught, ten survivors, eight closed by seven
      rows, two measured equivalent. No source change).
      THE BEST-HELD CLI FILE THIS SERIES HAS OPENED — eighteen of
      twenty-eight caught, the render path almost entirely pinned
      (the group marker, the plugin-gave-it-tasks note, the singular
      "1 task", the JSON list's exact shape, and every `taskBlock`
      field including the cache block, with a docs-drift row catching
      the one the e2e rows do not name).
      WHAT IT MISSED WAS THE SECOND ARM OF EVERY REFUSAL. The unknown-
      project guard fires for a bare name and for `pkg#task`, and only
      the bare form had a row; the other arm would reach
      `byName.get(name)!` and print a TypeError where the sentence
      belongs. `vx show app#` (nothing after the hash) has its own
      message and no row. `--format` with NO value takes the next argv,
      which is not there, and the empty string must fail validation
      rather than leaving `pretty` in place silently.
      A SUGGESTION SUFFIX MUST DISAPPEAR WHEN THERE IS NOTHING TO
      SUGGEST: with no near match the tail is omitted entirely, and
      nothing pinned that — "did you mean ?" passed every row.
      A SCOPED READ IS A PROMISE, NOT A SAVING. `vx show app` loads
      app's config alone, so a broken config in another package does
      not stop it answering; the run path has that row and the reader
      did not. Its control shows the unscoped listing DOES hit the
      broken config, so the fixture is really broken.
      A UNIT IS PART OF THE VALUE: the block row asserted `5000`
      appears, which a bare seconds-vs-milliseconds number satisfies
      just as well. The new row reads `timeout: 5000ms`.
      TWO MEASURED EQUIVALENT, both duplicated work. `suggest()`'s
      substring pass re-does what `nearMatches` already does inside
      (edit-distance.ts walks the same `includes` both ways); the only
      behaviour it adds is escaping nearMatches' `limit = 3`, which is
      a wart, not a contract, so it is recorded rather than pinned. And
      the `JSON.parse(JSON.stringify(x))` round-trip before the pretty
      print is a no-op: measured, `JSON.stringify(x, null, 2)` drops
      undefined-valued keys by itself and the two strings are
      identical.

549.  DONE (2026-09-21, `orchestrator/task-log-buffer.ts` — the bounded
      per-run log capture every telemetry sink shares. Never swept. 25
      mutations: eighteen caught, seven survivors, five closed by four
      rows, two measured equivalent. No source change).
      THE SECOND WELL-HELD FILE IN A ROW, and for the same reason 542
      was: the hard part is pinned member by member. Both caps, the
      whole-chunk eviction, the single-chunk slice and its direction,
      the per-chunk overhead (with the measured 1.4 MB vs 30 MB
      reasoning), the charge/release symmetry across replace, evict and
      take, successes stubbed before failures, the FIRST failure kept
      last, and the stub that keeps `content.length === charsFull -
truncatedHeadChars` honest — every one has a row named for it.
      TWO GUARDS THAT EACH REFUSE EVERYTHING THE OTHER DOES. `finish`
      drops a non-`miss` cacheSource AND a status that is neither
      success nor failed, and `deriveCacheSource` is a TOTAL function
      from status to source: a hit's status is never `success`, a
      `miss` never carries `skipped`. So each guard is a complete
      filter on its own, and removing either alone is invisible to
      every reachable input — measured, not assumed. The new row
      passes the two MISMATCHED pairs a future caller could hand it
      (`success` with `local`, `skipped` with `miss`) and requires both
      to drop, which is the only shape that separates them.
      AN EMPTY WRITE IS NOT OUTPUT. `append('')` returned early with no
      accumulator, and nothing said so: keeping it would ship an entry
      for a task that printed nothing, the same confusion the eviction
      stub exists to prevent, from the other direction.
      TWO DELIVERY PATHS, ONE CONTENT STRING. `takeEntry` and `drain`
      join the same chunk list, and only `drain`'s join had a witness —
      a separator in one would make the same run read differently
      depending on how a sink shipped it. And the drain ordering row
      pinned failures-before-successes but not the tiebreak INSIDE each
      tier, which is oldest-first so the log reads in run order.
      Two measured equivalent, both micro-optimisations: the
      early return in `evictToBudget` (the loop's own break covers it)
      and its `chars === 0` skip (a stub costs `budgetCost(0, 0)`,
      which is zero, so re-releasing it frees nothing).
      GATE NOTE, second sighting of the fourth flapper: this item's
      gate showed `vx watch loop (e2e) > a first sighting is a change
only when its mtime falls after the arm` — the row item 509's
      yardstick note already characterised as a flapper that appears
      only under the loaded sandboxed run. It timed out in `until` at
      `watch-loop.test.ts:86` waiting for the cycle, three isolated
      runs of the file were clean, and a CONTROL gate on a stashed tree
      at `origin/main` produced exactly the three recorded flappers and
      not this one. Still not added to `base.names`, for the reason
      given there: a yardstick entry swallows a real failure.

550.  DONE (2026-09-21, `orchestrator/lockfile-claim.ts` — the shell
      every lockfile plugin wraps its parser in: the memo, the per-run
      gate, the unlisted-project fallback, the `--affected` diff and
      `reachDigests`. Never swept. 34 mutations: eighteen caught,
      sixteen survivors, seven closed by six rows, nine classified. No
      source change).
      A METHOD FAILURE FIRST, because it nearly cost a false claim: a
      mutation that does not COMPILE reads as a SURVIVOR. Deleting a
      `catch` block left a dangling `try`; Bun printed `Unhandled error
between tests`, `0 pass` and no `(fail)` row, and the classifier —
      which counts failing rows — scored it SURVIVED. The write-up would
      have reported a hole in code the run never loaded. `sweepverdict.sh`
      now reports a module error, or a file that printed `0 pass` with
      no failing row, as INCONCLUSIVE. A bare `^error:` grep does NOT
      distinguish it (a failing assertion prints `error: expect(received)`
      too) and called all twenty-one real catches compile failures;
      the narrowed rule was re-run against every stored sweep log from
      544 through 550, and no earlier verdict was affected.
      `reachDigests` IS WHERE THE HOLES WERE — six of its seven
      mutations survived, in the most intricate code in the file
      (Tarjan's iterative walk plus a Merkle fold over components). The
      three rows that guard it say the right things and their fixtures
      cannot witness them: "independent of node numbering and edge
      order" permutes the NODES but leaves every node's children
      arriving in the same order, and the cycle row's ring closes with a
      back edge to the frame directly above, which the on-stack branch
      resolves alone. So: reversing one node's edge list, renumbering a
      two-member component, a THREE-node ring (which needs the low-link
      to travel back down the frame stack as each frame pops) and a
      self-loop (an edge inside a component is not a child) each get a
      row.
      THE TWO SECTION COUNTS COVER EACH OTHER, so only the JOINT
      mutation separates them. `members:N` and `children:N` introduce
      the fold's two halves; drop both and the halves become one chain,
      where a node whose CHILD digests to D collides exactly with a
      component whose MEMBER material is the string D — and a child
      digest is sixteen hex characters, which is what a lockfile's
      material often is. The row builds that collision and requires the
      two to differ.
      A MEMO THAT CANNOT BE WRITTEN is a speed-up lost, never a failed
      run — the source says so and nothing held it. The row points the
      cache dir at a path that is a FILE, so the write fails for every
      user including root, and asks for the key anyway.
      NINE CLASSIFIED. Five are cost gates whose absence only re-reads
      or re-parses (the absent-file memo, the mtime half of the stat
      gate, the stat gate itself, the content gate, the per-run
      WeakMap) — note the asymmetry: dropping SIZE from the stat gate
      was caught by eight rows, because mtime is what moves on an edit,
      while dropping MTIME is merely wasteful. Two are sibling-arm
      equivalences: the root project's importer spelled `''` instead of
      `'.'` misses and then falls back to the root importer, the same
      value; and `'no-importer'` versus `''` is one constant for
      another. One is a platform claim this Linux-only gate cannot
      see (`path.sep` is already `/` here). One is a race — the
      write-then-rename that keeps a reader from seeing a half-written
      memo, which `readMemo`'s own catch turns into a miss.

551.  DONE (2026-09-21, `orchestrator/status-line.ts` — the interactive
      status display and the writer that serialises every stdout write
      around it. Never swept. 30 mutations: twenty-two caught, eight
      survivors, four closed by four rows, four classified. No source
      change).
      THE THIRD WELL-HELD FILE RUNNING. The wrapped-row erase — the
      part that went wrong on a real pty at ~10 junk rows a second —
      has its own describe and pins the physical-row arithmetic, the
      visible-width measurement, the cursor-up sequence and its
      byte-identical single-row form. Both throttles, the coalesced
      trailing draw, the mid-line hold and the permanence of
      `clearStatus` all have rows too.
      WHAT SURVIVED WAS THE ARITHMETIC'S EDGES. A width of ZERO is the
      same unknown-width case as an absent one, and dividing by it
      yields Infinity rows and an erase of `ESC[InfinityA`, which is
      not an escape at all. And an EMPTY line measures 0 columns, so a
      bare `ceil(0 / cols)` counts it as no row — which would come up
      one row short of every region vx actually draws, since each one
      opens with the blank separator between the live region and the
      list scrolling above it.
      A ROW THAT PINS HEIGHT DOES NOT PIN COLUMN. "Idle rows hold their
      place so the slot zone height never changes" counts lines; the
      indent that puts `idle` under `running` is the other half of the
      same promise (layout shift IS the bug this display exists to
      fix), and the new row compares the two columns directly.
      AND A SLOT STAMPED AFTER the region's clock rendered a NEGATIVE
      age: the two clocks are read at different moments, and the
      `Math.max(0, …)` that covers it had no witness.
      A DUPLICATE I NEARLY ADDED, recorded because the method is the
      point: the trailing-draw-after-`clearStatus` row I wrote already
      exists, and its comment carries the same mutation result I had
      just re-derived ("removing the cancel alone kills nothing —
      verified by mutation"). Grep the describe, not just the file.
      Four classified: the `cancelTrailing` in `clearStatus` (covered
      by the callback's own `dead` guard — the joint mutation of both
      is what the existing row catches), the timer's `unref` (a stray
      timer holding the process open, which an in-process suite cannot
      observe), and `paintPinnedId`'s no-`#` arm (every caller passes a
      task id, which always has one).

552.  DONE (2026-09-21, `orchestrator/doctor.ts` — the facts `vx info`
      prints and `vx mcp`'s `getWorkspaceInfo` returns. Never swept. 32
      mutations: ten caught, twenty-one survivors, one INCONCLUSIVE,
      seven closed by six rows, fourteen classified. No source change).
      THE RENDERER WAS PINNED AND THE FACTS WERE NOT. `describeWorkers`
      and `describeMemory` have rows, and every one of them feeds a
      LITERAL facts object — so the strings are held to the byte while
      the numbers behind them were free. Five of the six new rows call
      `collectInfo` itself: the worker ladder (a declared `concurrency`
      wins and is labelled `workspace`, and a fact that reported the
      machine's cores under it would render "N — vx.workspace.ts" with
      the wrong N), the memory law (usable is the machine capped by
      whatever cgroup binds — inside a container `os.totalmem()` is the
      HOST's, and budgeting against it is the OOM killer's), the git
      version (the number, not git's sentence), the seam list
      (`teardown` is lifecycle, not a seam a task consults) and the
      config-error ordering (`Promise.all` settles in whatever order the
      reads finish, and these facts are pasted into bug reports and
      diffed between invocations).
      A REASON IS MASKED EVERYWHERE OR NOT AT ALL: the socket-path
      replace is global because a retry names two sockets, and a
      half-masked reason still differs between invocations, which is the
      whole point of the function. The existing row passes one socket.
      CAUGHT BY HANGING, recorded as 543 asks: dropping `resetSandbox()`
      from the doctor's probe does not redden a row — it leaves the
      Linux runtime's proxy sockets open and the test FILE never exits.
      The docstring says exactly that ("the probe initializes the Linux
      runtime, whose proxy sockets would keep a standalone process
      alive"), so the behaviour is witnessed, but only as a timeout with
      no failing name.
      FOURTEEN CLASSIFIED, and two are worth naming. `cores` has a
      `Math.max(1, …)` floor no real machine exercises. And the
      `cgroup`-versus-`cores` SOURCE label cannot be separated on this
      machine at all: the container binds a memory limit but no CPU
      quota, so `machineParallelism()` equals the core count and both
      arms agree. The new row states the law (`cgroup` exactly when the
      count is below the cores) and catches the `<`-to-`<=` mutation
      here; the arm itself waits for a host where a quota binds.
