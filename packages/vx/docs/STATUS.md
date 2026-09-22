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

## In flight

**The gate's runtime (settled 2026-09-21, item 572; plan F4).** A gate
under Bun 1.4.2 is the only gate: the 2026-09-19 container shipped
1.3.11, below `engines.bun: >=1.4`, and every "flapper" of that arc — the
shard-9 SIGILL (3 of 24 reps on 1.3.11, 0 of 24 on 1.4.2), the three
recorded failing tests, the inert symlink tripwires that scored three
containment guards as survivors — was the version. `bun upgrade` is
refused there; the release asset
`github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip`
downloads through the proxy and the gate with it first on PATH is 44 of
44 green. A shard failure under 1.4.2 is the diff's. The diagnosis of
the 23-test baseline as it stood on 1.3.11 is in
`docs/history/2026-09-status-next-log.md` § "In flight as it stood
2026-09-22"; the `ci` task refusing a Bun below the floor is plan F4.

**The sandbox arc (2026-09-05) is closed.** Its four Linux items closed
by 2026-09-10 (`docs/history/2026-09-status-next-log.md`); the fifth,
macOS violation reporting being lossy under load, is a recorded decision
since item 586 (Decisions below), not an open item.

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
2. OWNER: cut the release — the notes are drafted in
   `docs/history/release-0.1.0-notes.md` (item 581); a GitHub release with the tag is the whole
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
   the product. CI wall time is the other number this duty carries
   (plan I2): 2:23–3:16 per push run on main over 2026-09-21's eleven,
   all three jobs; a run past six minutes is the signal to fold the
   heaviest witness files onto a shared fixture. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
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
   needs an A/A control beside it. 2026-09-22 (item 580), the sweep week
   (items 342–572, PRs #488–#681) as one arm: base 164.7 ms, head
   167.8 ms warm min-of-15 at 1,000 projects, A/A 170.1 against 169.2 —
   a tie. Item 588 (the additive hit path, every task's): main 173.5
   against head 170.5, A/A 168.3 against 164.2 — a tie.

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
    in `docs/history/2026-09-status-next-log.md`; items 453–572 are in
    `docs/history/2026-09-improvement-loop-453-472.md` through
    `-553-572.md`. The loop above is the record since 573; 14aq is
    below with 14ar, 14as, 14at and 14au, and the next handoff written
    here is 14av.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14aq. **Handoff after item 573 (2026-09-22).** One item since 14ap, and
it is the shape of the week: 453–572 were a per-file mutation sweep
of core that found real stale-hit and containment defects (#667 #679
#680 #676 #661 #650 #642 #681), wrote the sweep rulebook into
CLAUDE.md, and closed the shard-9 SIGILL as Bun 1.3.11. It also left
STATUS at 5,803 lines, the suite 14k test lines heavier with no CI
budget, three findings recorded and not fixed (565: a gitignored
directory literal folds nothing — a stale hit; 478: the seatbelt
profile interpolates a resolved socket path unchecked; 495's
follow-up: the wildcard classifier spelled six ways), and no run-path
change to A/B. 573 trimmed the loop and wrote the plan. NEXT, in
order: plan F4 (the `ci` task refuses a Bun below `MIN_BUN`), F1
(stat, not `Bun.file`, in `settleLiterals`; differential row on an
ignored `gen/`), F3 (one predicate in `util/paths.ts`, measure the
brace bind first), then I1/I4 and D3 before D1. Owner asked
2026-09-22 whether D1 waits for a third repository. Never end with
"what next?".

14ar. **Handoff after item 584 (2026-09-22, evening).** Eleven items since
14aq, all on PR #487, which carries the first day of
`docs/design/plan-2026-09-22.md`: the gate refuses a Bun below the
floor (575) and prints its box (579); the three findings the sweep
recorded and left — a gitignored directory literal folding nothing
(576, stale hit), the wildcard class spelled nine ways (577), the
seatbelt profile's unchecked resolved path (582, testable on Linux
because the profile is text) — are closed with differential rows; the
sweep's rules left CLAUDE.md (578); the suite's cost has a number and
the weights are fresh (579); the sweep week A/B'd as a tie (580); the
0.1.0 notes are drafted (581); I3 and I5 declined with reasons (583);
and the `workspaceFiles` restore-tier exclusion is a reach test
(584, tier 0 → 1000 on the bench with one writer). One darwin-only
red: the seatbelt rows built paths under the unresolved temp dir;
fixed by realpath. WHAT REMAINS IN THE PLAN: D1 waits on the owner
(a third repository, or a waiver — asked 2026-09-22); D2 waits on a
workspace with > 100 MiB artifacts; F6 and D4's tail are the owner's
three items. NEXT, in order: In-flight 5 (macOS violation reporting
is lossy under load — the darwin CI job is the macOS box; design a
report that does not depend on the unified log keeping up, or gate
the failure on the denial the OS made rather than the record of it);
then a fresh-workspace persona walk on Bun 1.4.2 (`vx init` → run →
why → watch) for what the week's fixes changed for a user; then Next
1's whole-graph REAPI run if a worker-side change needs it. The
manual gate script in this container runs oxlint/oxfmt through
`bunx` (bare names are not on its PATH). Never end with "what next?".

14as. **Handoff after item 588 (2026-09-22, night).** Four items since
14ar, on PR #682: the fresh-workspace walk found nothing off (585);
In-flight 5 is a decision, not an item (586); D1's gate was answered
by surveying twelve more monorepos — twenty and storybook show the
addition shape, so with strapi that is three (587); and D1 shipped
(588): two cached tasks of one project may share a tree when an edge
orders them, the dependant owns what it adds. The plan of 2026-09-22 is
now exhausted except D2 (waits on a workspace with > 100 MiB
artifacts) and the owner's three items; the review doc's D1 question is
moot. NEXT, in order: merge #682 when green; then the warm-path A/B
duty for 588 (it touches the hit path of every task through
`isAddition` — an empty `addedGlobs` costs one `some` per row, but
the rule is a number, not a belief); then Next 1's whole-graph REAPI
run if a worker-side change needs it; then the launch is the owner's.
Never end with "what next?".

14at. **Handoff after item 589 (2026-09-22, late).** Everything is merged
(#487, #682, #683) and the branch stands on main with nothing in
flight. 589 closed the one observation 588 left (a rowless hit no
longer extracts its empty artifact), and the schema page and the
ownership post name the ordered overlap. STATE OF THE PLAN
(`docs/design/plan-2026-09-22.md`): every fix, improvement and arc is
DONE or DECLINED with its reason, except D2 (the streaming remote
seam, gated on a workspace with > 100 MiB artifacts) and the owner's
three items (delete `NPM_TOKEN`, cut `0.1.0` from the drafted notes,
the site's address). The Next list holds nothing an agent can start
without an external event. WHAT A NEXT SESSION DOES: the daily duties
(Next 6's warm A/B on any run-path change, with the A/A control; a
STATUS trim at twenty items — the loop holds 573–589 now); a
fresh-workspace walk when a user-facing surface changes; and, if the
owner cuts the release, the site's benchmark refresh on the dev box.
Do not start another mutation sweep (item 572's bar stands), do not
narrow `local-shortcircuit.ts` without its pins, and do not touch the
additive-output path (588) without the ten-row matrix red first. Never
end with "what next?".

14au. **Handoff after item 590 (2026-09-22, night).** One item since
14at, and it is a new adoption surface: the owner asked for Nx
executors to run under vx with no config change, then for the
explicit `nx-exec <executor> [options]` shape; 590 shipped `nx-exec`,
the `nx()` plugin and the migrator's use of both, with the design and
the per-task numbers in `docs/design/nx-unchanged-2026-09.md`. The
owner's standing direction after that: "never stop — find, simplify,
speed up and improve things." WHAT TO WATCH: the live suite is new in
CI's packages job (`npm install nx@22` into `packages/vx-migrate/.nx-live`,
then the sandboxed `test` task with `VX_NX_MODULES` and
`VX_REQUIRE_NX`); if Nx cannot compute a graph inside the sandbox
(a write outside the project, a socket), the fix is a grant on that
task, not an unsandboxed one. NEXT, in order: a real-Nx dogfood of
`nx()` on a cloned repo (TanStack/router or refine, both Nx: run
`vx run build --all` through the plugin and compare the set and the
outputs with `nx run-many`); then the warm A/B duty (590 touches no
core run path, so no arm — confirm by diff); then the daily duties of
14at (STATUS trim at twenty items; the loop holds 573–590). Never end
with "what next?".

## Decisions (this arc)

- **macOS violation reporting is lossy under load, and stays so
  (2026-09-22, item 586).** The store is fed by the unified log, which
  drops records under pressure; the settle window that halved the loss
  cost 300 ms per clean sandboxed task and went 2026-09-05 (owner); no
  unprivileged channel reports a denial the child survived. Enforcement
  is unaffected and the Known limits page says so. Not an open item.
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
