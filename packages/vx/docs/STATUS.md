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
(handoffs 14ao–14ap to the next-log file), and items 453–572 to six
files of twenty, `docs/history/2026-09-improvement-loop-453-472.md`
through `-553-572.md`, on 2026-09-22 (item 573), and items 573–591 to
`docs/history/2026-09-improvement-loop-573-591.md` later that day
(handoffs 14aq–14au to the next-log file, item 592), and items 592–611
to `docs/history/2026-09-improvement-loop-592-611.md` on 2026-09-23
(handoffs 14av–14ax to the next-log file, item 612), and items 612–631
to `docs/history/2026-09-improvement-loop-612-631.md` that afternoon
(handoffs 14ay–14ba to the next-log file, item 632), and items 632–654
to `docs/history/2026-09-improvement-loop-632-654.md` that night
(entries 14bb–14bv to the next-log file, item 677), so
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

719.  DONE (2026-09-24, the trim after track W closed). Entries
      14bw–14di (items 675–713) and loop item 677 moved to the next-log
      file in this commit, and handoff 14dj replaced them. What that
      stretch was: the site redo, W0–W12, each Learn page teaching the
      idea before vx and each widget held to the CLI, with core fixes
      found on the way (the 32-bit seed chain, non-JSON configs, the
      recap a CI log needed). Next trim when the entries below reach
      twenty.

720.  DONE (2026-09-24, Next 17 step 1). A sandboxed task no longer gets
      its own project back through a `node_modules` link. npm and Yarn
      link every workspace package at the root, the task's own included,
      and `linkedDeps` granted that target whole: the correctness demo
      (grant = inputs = `src/**`, `cat banner.txt`) passed unreported and
      an edit to `banner.txt` hit, replaying the old banner. It now drops
      a target that is the task's canonical project directory or holds
      it, both sides realpath'd (a symlinked root, macOS `/var`, kept the
      grant otherwise). Rows: `sandbox-request.test.ts` (exact grant set,
      canonical and symlinked root) and `sandbox-runtime.unsafe.test.ts`
      (the demo in an npm layout fails with one `banner.txt` line, before
      and after an edit; symlinked root; control: a sibling's link still
      reads); five mutations, each caught. `CACHE_VERSION` v30: an entry
      saved before the fix sits under a key that never saw the file, so
      it would hit for as long as only that file changes. Fallout:
      `@vzn/vx#check.bun` passed only through the root `@vzn/vx` link (Bun
      probes `bunfig.toml`; on macOS seatbelt refuses an ungranted cwd, so
      the granted script read as "Module not found", caught by darwin CI
      only) and now grants `.`, safe as the task is uncached. This repo's seven
      root-declared packages are self-linked under a fresh Bun install
      too, so the bug was live on CI for them. Refuted along the way: "this
      box's sandbox does not enforce read denies" — it does; the
      cross-project read that succeeded was re-allowed by the link grant.

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
   violation reporting is lossy under load (In-flight 5);
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
2. DONE 2026-09-23 as item 662 (entry 14bj) — the remote seam streams: `get` resolves `Blob | Response`, `put` takes a file-backed `Blob`, every first-party layer moved in the same commit.
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
   against head 170.5, A/A 168.3 against 164.2 — a tie. The COLD path
   has its own number since 2026-09-23 (item 615): 1,000 projects,
   `.vx` removed, 2,938–3,420 ms before against 2,680–2,997 after, the
   `load configs` stage 507–607 → 207–272; a cold arm is five reps with
   the cache removed before each, no A/A needed at that size. 2026-09-24 (items
   690–702, the day's run-path changes being the key fold's move to
   `key-fold.ts`, one config worker per repeat round and the JSON-data
   walk): base 39294a8d against head, compiled binaries, 1,000 projects
   warm, interleaved, n=25 — medians 266.5 ms before and 266.4 after,
   mins 245.1 and 230.8; A/A 270.4 against 264.8 (mins 238.5, 238.1).
   A tie; a first n=15 pass read the mins the other way round (225.9
   before, 251.8 after) with the same tied medians, which is the box's
   min-of-N noise, not a cost.

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
    `-553-572.md`; items 573–591 are in
    `docs/history/2026-09-improvement-loop-573-591.md`, 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md`, 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md` and 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md` (entries
    14aq–14di and loop item 677 in the next-log file). The loop above
    is the record since 719; 14dj is below, and the next entry written
    here is 14dk.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dj. **Handoff after item 719 (2026-09-24, morning).** Since 14by the
arc shipped the site that teaches, track W whole: the Learn section and
its island pattern (675), the planner in the browser (676 spike, 691,
692, 695, 699, 700, 703), what-is (681), caching and the key calculator
(684), scheduling on vx's own ranking code (685), architecture and
extending (686), correctness and the stale-hit demo (688), choosing
(689), the glossary (683), the labs (704), the checkpoints (705, 710),
the landing (709), a site-wide link check (711, which found a page the
importer had lost to a name collision) and the landing's figures held
to their sources (712). Core alongside: a 64-bit key chain (682), a
config is JSON data on every path (701), the run's `Failed:` recap
(706), a locale-free key diff (707), one config worker per watch round
(694); the site's prerender runs under Bun (708); the 0.1.0 notes run
through 710 (713). WHAT STANDS: entries 14bw–14di and loop item 677 are
in the next-log file (§ Entries 14bw–14di); the loop holds 719 alone.
The owner then judged the site "very bad": pages were added to the old
structure instead of redoing it, and nothing tells one story. The redo
is `design/site-redo-2026-09.md` (Next 16): one Guide of ten chapters on
one toy monorepo (why, tasks, dependencies, concurrency, caching, trust,
affected, many machines, inside vx, try it), Docs and Reference around
it, internals out of the sidebar, one look, build-time SVG diagrams.
The audit's 714–718 are dropped; their substance feeds chapters 3, 7, 8
and the "vx, Turborepo, Nx, Bazel" page. IN FLIGHT: R1 (the skeleton)
and R2 (the chapters, three implementers); the design for Next 17 (a
sandboxed task reads a linked sibling package unseen) from an
architect. OWNER, unchanged: cut 0.1.0 (the tag, then delete
`NPM_TOKEN`), the site's address, the scope list (roadmap 2.4), the
soak length. NEXT: R1–R4 in the design's order, each chapter edited by
the architect before it merges; then Next 17. Never end with "what next?".

16. **The site, redone as one story (owner, 2026-09-24).** Track W
    (entries 14bw–14di in the next-log file) built working widgets and
    ten Learn pages, but inside the old eight-group sidebar, as reference
    text with a competitor tour on every page; the owner: "I told you to
    redo it not add sections. It should tell a coherent story and teach
    about tasks, dependencies, sandbox, caching, concurrency, and other
    concepts to understand why you need task orchestration." The redo is
    `design/site-redo-2026-09.md`: a ten-chapter Guide read in order on
    the toy monorepo, Docs (one page per job) and Reference around it,
    internals out of the sidebar, the landing's look site-wide,
    build-time SVG instead of client Mermaid, the landing as the book's
    cover. The widgets and their CLI parity rows survive; the pages
    around them go. Order: R1 skeleton, R2 chapters (three in parallel),
    R3 docs consolidation and landing, R4 the old Learn pages redirect.

17. **A sandboxed task reads a linked sibling package unseen (found by
    the capability audit, 2026-09-24).** `sandbox-request.ts` grants
    every `node_modules` link from the project and the workspace root
    (`linkedDeps`), and reports only inside the project
    (`reportWithin`). So a task that reads a workspace package's source
    through its link, with no `dependsOn` edge to one of that package's
    tasks, is neither denied nor reported, and an edit there does not
    move its key: the stale hit the sandbox exists to prove absent.
    `learn/correctness` names `node_modules` as always readable, but a
    reader takes that for third-party code. Design first (architect):
    report such a read as a violation, deny it, or fold the linked
    package's inputs, each against this repo's own `source` tasks (item
    687), which already key what the suites import; item 717's pin row
    is the repro. Design: `design/linked-sibling-reads-2026-09.md`
    (deny, bounded by the key). Step 1, the self-link, shipped as item 720. Step 2 is next: grant a sibling's link only when the task's key
    covers that package (rules 2–6; rows R1's keyed parts, R3–R6, R8, R9;
    the cost on vx-bench's 1,000-package workspace and a gate A/B), with
    a Decisions entry: declaring `cache` may narrow core's own grant,
    never widen it, a bounded departure from 2026-09-05.

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
