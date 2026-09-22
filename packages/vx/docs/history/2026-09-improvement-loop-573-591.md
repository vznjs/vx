# Shipped, 2026-09 — improvement-loop items 573–591

The record `docs/STATUS.md` carried until 2026-09-22, moved here whole
when the loop reached twenty entries (item 592; 592 itself opens the next loop). A PREFIX,
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
`2026-09-improvement-loop-513-532.md`, items 533–552 in
`2026-09-improvement-loop-533-552.md`, items 553–572 in
`2026-09-improvement-loop-553-572.md`; items 592 onward continue in
`docs/STATUS.md`.

573.  DONE (2026-09-22, the trim the loop was owed since 452, and the
      plan the week after the sweep works from). Items 453–572 moved
      whole into six history files of twenty, `2026-09-improvement-loop-453-472.md`
      through `-553-572.md`, every removed line checked
      present in its new file before the write; STATUS 5,803 → under
      600 lines. `docs/design/plan-2026-09-22.md` is the review of
      that week in repo form: six fixes (F1–F6), seven improvements
      (I1–I7), five arcs (D1–D5), each with its seam, constraint,
      measurement and what not to do; Next 15 points at it. Handoff
      14aq below. Rule for the entries that follow (plan I4): twelve
      lines — what changed, the number, the test; the why is the PR.

574.  DONE (2026-09-22, the 2026-09-16 PR #487 that the sweep week left
      open, rebased: the what-vx-is post named ten of the thirteen plugin
      hooks (`admit`, `setup`, `teardown` missing) — every `PLUGIN_HOOKS`
      name is in its pipeline paragraph now, pinned to the list; the
      no-choice post spelled the warm figures its own way — now the
      benchmarks page's (3.59s, 760ms), pinned; the values post's
      principle count is pinned to CLAUDE.md. Three rows in
      `site-samples.unsafe.test.ts`; two fail on the old posts.

575.  DONE (2026-09-22, plan F4: the gate refuses a Bun below the floor).
      `check.bun` (`scripts/bun-floor.ts`) is a new uncached core task
      that `install` depends on, so every shard, the unsafe suite, lint
      and the binary check wait on it; below `MIN_BUN` it exits 1 in
      under a second naming the release asset that downloads where
      `bun upgrade` is refused. `bin.ts` still only warns for a user.
      `tests/bun-floor.test.ts`: the verdict both ways, the asset name
      per platform, and the script's exit on the running Bun. Ran
      sandboxed as `probe` with `VX_REQUIRE_SANDBOX=1`: 88 ms.

576.  DONE (2026-09-22, plan F1: a gitignored DIRECTORY named as a literal
      input folded nothing in silence — 565's finding, a stale hit).
      `assertNoInvisibleLiteralInputs` judged existence by
      `Bun.file(p).exists()`, which is false for a directory on 1.3.11
      and 1.4.2 alike, so it `continue`d past every literal naming one.
      Existence is lstat now; an EMPTY directory is refused by the same
      rule (decided: nothing under it can fold). Two rows in
      `inputs-resolution.test.ts`, both red without the fix (run), with
      the file-inside control beside the empty one. The class grepped:
      the 17 other `Bun.file(…).exists()` sites in `src/` take file
      paths; `tests/bun-file-exists-sites.test.ts` pins that set (plan
      I7) so a new site is read for a directory operand.

577.  DONE (2026-09-22, plan F3: the wildcard class was spelled nine
      times — five with `{}`, four without). Two alphabets now, one
      question each: `GLOB_WILDCARDS` / `isLiteralPattern` (util/paths.ts,
      "must this declaration be MATCHED") at six sites incl. env names;
      `MOUNT_WILDCARDS` / `isMountableLiteral` (exec/sandbox-paths.ts,
      "can this grant be MOUNTED") at four. The brace is the whole
      difference, and measured: `write: ['g/{a,b}.txt']` works as a
      literal (placeholder, widened to `g/`) and, scanned, fails with
      `Read-only file system` — new unsafe row, red with `{}` in the
      mount set (run). `tests/sandbox-paths.test.ts`: both alphabets by
      member, the source-diff pin, and no inline `[*?[` outside the
      two homes. No behaviour change at any site.

578.  DONE (2026-09-22, plan I1 and I4: the sweep's rules leave the
      every-session memory). Twenty-six CLAUDE.md rules that only apply
      while sweeping moved verbatim to
      `docs/design/mutation-sweeps-2026-09.md`, under a seven-step
      method distilled from them; CLAUDE.md keeps a pointer and five
      short general rules (masking guards, the positive before the
      negative, suspect the container, stat not `Bun.file`, the
      platform answer in the file). CLAUDE.md 542 → 351 lines. I4 is
      the item rule 573 set and 575–577 follow: twelve lines, the
      number, the test; the why is the PR.

579.  DONE (2026-09-22, plan I2 and I6: the suite's cost has a number and
      the gate prints its box). CI wall time on main, eleven push runs
      2026-09-21 (#671–#681): 2:23–3:16 each, all three jobs — under a
      six-minute budget, so no witness file folds. `shard-weights.json`
      refreshed from a JUnit run of all twelve shards on this box (Bun
      1.4.2, 195 files, 17 of them new since 2026-09-16); the dealer
      now balances to 15,968–15,969 ms per shard. `check.bun` prints a
      second line — platform, cores with the cgroup quota, memory with
      the cgroup limit, from `util/cgroup.ts` — so a figure recorded
      from this gate carries where it was measured; the row in
      `bun-floor.test.ts` pins its shape.

580.  DONE (2026-09-22, plan D5: the sweep week's run-path changes
      A/B'd, since none was measured as it landed). Compiled binaries,
      main before the week (40aaab2f) against this branch, 1,000
      projects warm all-hit, interleaved min-of-15, one copy per arm
      pre-warmed by its arm: base 164.7 ms, head 167.8 ms. The A/A
      control (base over both copies) read 170.1 against 169.2, so a
      3 ms gap is inside this box's spread: a TIE, recorded as one.
      #667's per-glob negation walk and #679/#680's git checks cost
      nothing the warm path can see. Harness: `ab-week.ts` shape under
      Next 6 (arms, A/A, min-of-N).

581.  DONE (2026-09-22, plan D4, the agent's half: the release is one
      click away). `docs/history/release-0.1.0-notes.md` groups the 341
      PR titles since v0.0.21 by what a user meets (selecting, caching,
      sandbox, failures, plugins, CLI, docs; internals in one line), so
      the owner cuts `0.1.0` from it. The compiled-binary canary and
      the site build ran green in this gate. NOT done: refreshing the
      site's benchmark numbers — they were measured on the dev box, and
      Next 6 says this container's absolutes are a different machine;
      the owner's three items stand (NPM_TOKEN, the tag, the address).

582.  DONE (2026-09-22, plan F2: the seatbelt profile's one unchecked
      interpolation, 478's finding). The unix-socket loop emitted the
      declared path through `sbplPath` and `toRealPath(sock)` raw, so a
      symlink whose TARGET carried a quote rewrote the policy. A second
      checker for filesystem-resolved paths refuses only what can leave
      the quoted SBPL string or the shell argument (`"`, `'`, `\`, a
      control character) — a space stays legal, so `/Users/Jane Smith`
      is not regressed. Testable on Linux: `macProfileRules` builds text
      and runs no seatbelt. `tests/seatbelt-profile.test.ts`: the
      injection row (red with the one line reverted), the space and
      plain-path controls, the checker member by member.

583.  DECLINED (2026-09-22, plan I3 and I5, evaluated against the code).
      I3 (one `tests/doc-pins/` directory for the three pin files): the
      three answer different questions by design — interface field
      lists, rendered samples byte for byte, class greps over every
      page — and share only `handAuthoredDocs()`, which doc-class-pins
      already owns; and `scripts/test-shard.ts` deals `readdirSync(TESTS)`
      FLAT, so a subdirectory is invisible to the shards until the dealer
      changes too. 2,751 lines moved for no new claim. I5 (a witness
      dies with its guard): `oxlint --type-check` runs over `tests/` in
      the gate, so a witness importing a removed symbol already fails;
      a string-anchored witness holds the message it asserts. Nothing
      to add. Both struck in the plan with these reasons.

584.  DONE (2026-09-22, plan D3: the `workspaceFiles` restore-tier
      exclusion is a reach test, not a graph-wide switch).
      `restoreTierExclusions` (local-shortcircuit.ts) keeps out every
      task whose project directory — or own `workspaceFiles` input
      prefix — a declared workspace output's `staticPrefix` reaches, and
      every transitive dependant of one (its up-front key folds a
      preliminary key); a prefix at the root keeps the old rule. Item
      425's pin is rewritten as four path-based rows plus the design
      note's fixture, all red under the old rule (run); the BOTH-tiers
      row now holds the producer alone in the tier. Measured, 1,000
      projects with one writer of `shared/x.txt`: tier 0 → 1000; warm
      all-hit min-of-11 base 177.2 ms, head 176.2 — a tie, as the tier
      pays on mixed workloads. caching.md, the module page and the
      overlapping-outputs note say the new rule.

585.  DONE (2026-09-22, the fresh-workspace walk on Bun 1.4.2 with the
      day's compiled binary: two packages, `vx init` → cache blocks per
      its TODO → cold run → warm run → `vx why` → an upstream edit →
      `why` again → `vx last` → `vx info` → `vx watch` with an edit and
      Ctrl-C). Every surface read true: `why` named the changed upstream
      and its key pair, `last` the two executed tasks with their cpu
      ratio, `info` the floor, the cgroup memory line and the sandbox
      verdict, `watch` the file that started its cycle. Nothing off;
      recorded so the next walk starts from what this one covered.

586.  DECIDED (2026-09-22, In-flight 5 closed: macOS violation reporting
      stays lossy under load, by design). The report reads a store the
      unified log feeds asynchronously and drops under pressure; the
      settle window that halved the loss (5.0 % → 2.2 %) cost 300 ms on
      every clean sandboxed task and the owner removed it 2026-09-05; an
      unprivileged process has no other channel for a denial that does
      not kill the child (no strace on macOS, dtrace needs root).
      Enforcement is unaffected. The introduction's Known limits already
      say so; this moves the item from In flight to Decisions.

587.  DONE (2026-09-22, D1's gate answered by survey rather than by
      waiting). Twelve more real monorepos scanned statically for two
      cached targets of one project on overlapping outputs with an edge
      between them: twenty (2 projects, `build` → `dist`,
      `build:individual` → `dist/individual`) and storybook (44 sandbox
      projects, `sandbox` → `sandbox/<dir>`, `build` →
      `…/storybook-static`) show the ADDITION shape; ten show none; no
      new rewrite-in-place. With strapi that is three, the note's own
      condition (1). Table in the design note. D1 is the next arc, on
      the note's design and matrix; the owner's waiver is no longer
      needed.

588.  DONE (2026-09-22, plan D1: overlapping outputs, the addition shape,
      on the design note's design). An overlap WITH an edge is marked at
      graph build (`addsToOutputsOf` / `outputsAddedToBy`), not refused;
      the dependant's own set is what its run added or changed against a
      size+mtime stamp taken before it (`stampOutputs`, `ownOutputsSince`),
      it cleans and is judged current by its rows (`cleanOutputPaths`),
      and the upstream drops strays a dependant's glob could have added
      before judging its tree. `tests/overlapping-outputs.test.ts`: the
      note's matrix over twenty's subdirectory shape and strapi's
      same-tree shape, ten rows, each tree byte-identical to a cold run;
      each of the three mechanisms reddens rows when disabled (run). The
      migrator keeps an edge-ordered dependant cached. caching.md § Additive
      outputs is the contract. Warm A/B, main against this head, 1,000
      projects min-of-15: 173.5 vs 170.5 ms, A/A 168.3 vs 164.2 — a tie.
      Observed, not 588's, and closed in 589: a hit whose entry has no
      rows extracted its empty artifact rather than skipping.

589.  DONE (2026-09-22, the observation 588 recorded). A hit whose entry
      holds no rows — its declared outputs matched nothing at save time,
      the warned case — extracted its empty artifact on every hit and
      reported a restore. Now it is up-to-date while its globs still
      match nothing (one walk, no tar read), and a stray under the glob
      still falls through to the clean, as strict ownership requires.
      Row in `cache-declaration-warnings.test.ts`, red without the
      change; the matrix's `noop` rows read plain hits now.

590.  DONE (2026-09-22, owner's ask: "support nx more, like their
      executors … current nx configs, no changes … not in core"). An Nx
      repo runs under vx with only a `vx.workspace.ts`: `nx()` in
      `@vzn/vx-migrate` fills the `project` stage from Nx's RESOLVED
      graph (snapshot under the cache dir, refreshed by `nx graph
--file` when `nx.json` or a `project.json` is newer, else the
      stats alone), and every executor target is an `nx-exec` line —
      a Node bin over Nx's public `runExecutor` that replaces the
      target in the in-memory graph with the executor and options on
      its command line, so the key sees them and the line pastes into
      a shell. Measured against `nx run` daemon-off: 656 → 245 ms per
      task at 200 projects, 1,104 → 272 at 1,000; a warm vx run pays
      nothing. The migrator writes the same lines where it wrote a
      placeholder. `tests/nx-exec.test.ts` (fake nx), `nx.test.ts`
      (the plugin, a real round trip through the bin), the live suite
      against Nx 22 in CI's packages job (`VX_REQUIRE_NX`). Design:
      `docs/design/nx-unchanged-2026-09.md`.

591.  DONE (2026-09-22, the real-Nx dogfood 14au asked for, on refine:
      Nx 18.2, 38 packages + 167 examples). `nx()` on the clone with only
      a `vx.workspace.mjs`: the first `--dry` paid one graph export (17 s,
      Nx's own daemon-less computation), the second read the snapshot in
      0.28 s; the build set equals `nx show projects --with-target build`
      (205 = 205, no difference either way); `@refinedev/core#build` and
      its two dependencies through the plugin wrote the same 1,320 files
      by name and size as `nx run --skip-nx-cache` (8.1 s against 11.1 s),
      and a restore replayed them identically in 0.36 s. Two mapping
      defects it surfaced, fixed: a target with outputs and no `cache`
      was cached (refine's 204 persistent `dev` targets) — Nx's rule now,
      `cache: true` or the legacy `cacheableOperations` list, never a
      persistent task; and "no inputs" is Nx's `default` named input, not
      a gap to report (487 lines per run). Rows in `migrate.test.ts`
      (executors, pkg-b); refine's warnings went from three lines to the
      persistent note alone.
