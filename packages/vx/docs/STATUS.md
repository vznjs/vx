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
(handoffs 14q–14v to the next-log file), so this file stays the handoff
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

282.  DONE (2026-09-16, the inner-loop persona 14w named): a watch of
      `test` across a fresh two-package workspace where app's test
      depends on lib's, driven on the loop's own markers (the
      `watching` line, then `re-running...`): a breaking edit to lib's
      source was one cycle — the `◼` row, the frame with the test's
      stderr, the footer's `1 failed · 2 success · 1 skipped`, the
      Skipped section naming `@acme/app#test` after `@acme/lib#test`
      failed — and the fixing edit one green cycle of hits (broad flow,
      so the footer alone, `3 up-to-date · 1 local`); `vx last --list`
      shows the red cycle as FAILED between two ok ones and its replay
      carries `after @acme/lib#test failed`. Every surface read right;
      nothing to fix. The probe's first run broke nothing because its
      "broken" flag contains "ok" — the grep matched; a probe's
      negative case is checked before its result is read. With 282
      the loop stands at forty: items 243–281 moved to
      `docs/history/2026-09-improvement-loop-243-281.md` and handoffs
      14q–14v to the next-log file in this commit.
283.  DONE (2026-09-16, the READMEs read against the code, the class
      of 277–279 on the last pages not yet read that way): the root
      README's maturity table said the plugin pipeline has 9 hooks
      where `PLUGIN_HOOKS` lists 13 (`fingerprint`, `admit` and
      `teardown` arrived after the count), and the same page and table
      said "~2,500 core tests" where the gate's twelve shards pass
      2,977 and the unsafe suite adds to that (2,553 `it` sites, 27 of
      them `it.each`). Both counts corrected; the hook count is pinned
      beside the hook-table pins, which needed a read across the
      project boundary — declared on the shard tasks as a sandbox
      grant and a `workspaceFiles` input, so a README edit re-keys
      the shards, the way `@vzn/vx-docs` reads core's docs. The
      benchmark figures on the same page carry their dated footnote
      and match `docs/benchmarks.md`; the package README states no
      count.
284.  DONE (2026-09-16, the pages a newcomer copies from, read the
      way the plugins guide is): every `defineProject` /
      `defineWorkspace` block on the site compiled against the façade
      (30 blocks across 21 pages, the plugins guide aside — it has its
      own pin). One was wrong: schema.md's "Full example" declared a
      `ci` group depending on `format-check` and `lint`, two tasks the
      example never declared, and the typed `dependsOn` rejects it —
      a red squiggle on the page's centrepiece since the typing
      arrived, and nothing read it. The example now declares both
      (two cached checks with no outputs) and says why the name must
      exist. `config-snippets.test.ts` in the site package compiles
      every such block on every page: a block counts when it calls
      one of the two and imports only `@vzn/*` packages, so the
      fragments (a skeleton with placeholders, a signature sketch, a
      preset path that exists in prose) stay out; the plugin packages
      the site does not depend on are ambient-typed, as the plugins
      pin types Sentry, since the claim is core's config types. The
      pin's first run named two more pages: the extensibility guide's
      remote-cache sketch passed the seam's `ArrayBuffer | Uint8Array`
      body straight to `fetch`, which Bun's types refuse (one
      `Uint8Array` view over either shape now), and the
      workspace-config guide's plugin block called `defineWorkspace`
      without importing it. Three pages, each a red squiggle for
      whoever copied it.
285.  DONE (2026-09-16, Next 6 — the day's closing diff on the warm
      path): after #434–#444 (275–284: the skipped label on every
      surface, the folded `vx last`, the Skipped section's group
      filter, the shards' README grant, the rest docs and pins), the
      interleaved A/B on one 1,000-project workspace copy per arm, the
      main of 274 (#433) in an immutable worktree against the head of
      284, 9 reps each, run twice with the arms swapped: before 257 /
      267 and 265 / 271 ms (min / median), after 252 / 269 and 262 /
      267 — a tie, as at 274. Expected: a warm run executes nothing,
      and the day's run-path diffs are one label and one filter over
      the outcomes.
286.  DONE (2026-09-16, the class of 284 on the plugin packages'
      READMEs, probed and declined as a pin): the sixteen `ts` blocks
      across seven package READMEs compiled the same way — every block
      with full imports passes; what fails is by convention (an
      options fragment that omits its import, a field list that is not
      code) or an artefact of the probe (`@vzn/vx-migrate` is linked
      nowhere at the root). A pin in the site package would have to
      ambient-type five of the seven packages, since the site depends
      on two, so it would check core's types and call the plugin's
      option shapes `any` — a claim not worth a grant on the site's
      test task and five new devDependencies. Revisit when a
      package's README block is the thing that broke.
287.  DONE (2026-09-16, the CI author's persona — `--affected` on a
      branch): a fresh three-package repo, `app` depending on `lib`,
      `lib` edited on a branch, `vx run test --affected=main` selected
      ONE project and ran lib's tasks alone; `--filter '...[main]'`
      selected three. The sugar was the changed-only `[<base>]` form,
      documented as such in the reference with a rationale ("test what
      I touched") — while the CI guide promised "changed packages (and
      their dependents) run" over the very recipe, the running-tasks
      guide drew dependents into its diagram, and the flag's name says
      it. An adopter's gate had a silent hole: an edit to `lib` never
      ran `app`'s tests. Decision: the sugar is `...[<base>]`, changed
      projects and their dependents, the superset a gate needs; the
      plain `[<base>]` filter stays the "only what I touched" form. One
      line, the help text, the reference's row, section and example
      swapped, a Decisions entry, the parity table's `≠` row closed
      and the two parity suites that pinned the divergence turned to
      pin the parity; the guides are true as written. Pinned
      end to end on a manifest edge (lib and app selected, tool not),
      with the plain form as the control (lib alone).

## In flight

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
   config is what makes 5,000 cheaper per project than 1,000.

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
    270 and 275 (14–14v) are in
    `docs/history/2026-09-status-next-log.md`; 14w and 14x below are the
    current ones.

14w. **Handoff after item 281 (2026-09-16, afternoon).** Six items
since 14v, merged as #436–#440: the second first-run walkthrough
found nothing to fix (276) and then read each page against the
renderer it describes — the broad-run sample (277), the frame
anatomy (278) and the status-line doc's phantom Failures zone (279)
had each drifted, and two byte-for-byte pins now hold the first two;
the reader at scale (a thousand projects, one leaf broken) found
`vx last` a thousand rows deep with the failure at the top (280,
hits fold past sixteen) and the Skipped section naming groups no
other counter counts (281). Open: Next 1, 2 and 16, all gated by
their own terms; In-flight 5 (macOS); the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 39 items (243–281): the trim's trigger is
forty, so the item after next moves 243 onward to history. The box:
as 14v; #440's first head went red in `test.bun.shard-4`, a shard
holding none of its files — the Actions API serves at most the last
five thousand log lines, which stop short of an early shard's
section, the blob host the full log lives on is denied by the
egress proxy, and the run uploads no artifacts, so a CI failure in
an early shard cannot be named from here; three local runs passed,
and with no re-run tool the one legitimate re-run was the push of
the next real change (281), after one comment on the PR saying so
— it came back green. A chain that ends in a subshell whose last
command is a grep passes whatever the scan said (the STATUS span
that wrapped in 280 was committed that way and amended); capture
`rc=$?` before the grep. Methods that paid: a page that describes
output is read against the renderer, not against memory (277–279);
a probe at scale asks what two packages cannot (280); the counter
every other surface excludes is the one to check in a new surface
(281). Next: the trim after the next item, then a persona not yet
walked — the inner loop, `vx watch` through a failing edit and the
fixing one, with the reason surfaces read as they cycle. Never end
with "what next?".

14x. **Handoff after item 287 (2026-09-16, mid-afternoon).** Six
items since 14w, merged as #442–#446 with #446 open: the watch
persona read right (282) and the loop was trimmed to history; the
READMEs' counts corrected and the hook count pinned across the project
boundary (283); every config block on the site compiled, three pages
fixed (284); the day's warm-path A/B a tie (285); the package READMEs
probed and their pin declined with the reason (286); and `--affected`
changed to include dependents (287) — the reference documented the
changed-only form with a rationale while two guides and the flag's
name promised dependents, so an adopter's gate never ran a dependent's
tests; a Decisions entry records the call and the parity table's `≠`
row is closed. Open: Next 1, 2 and 16, all gated by their own terms;
In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret, the
release cut, the site's address. No open issues. The loop holds six
items (282–287) after the trim. The box: as 14w; a Python edit script
that writes files before its last assertion leaves a half-done tree
when that assertion fails, and a chain gated on the scan and the tests
committed it (the trim, twice in one turn) — gate the chain on the
script's own exit and make every write idempotent; an item inserted at
the blank line after the last item lands BEFORE any item that follows
it, so a cut "to the next item" misses the one you just wrote — count
what the cut holds before writing the file; a type-checker pointed at
a directory holding a symlinked `node_modules` walks it until the
kernel kills it — name the files; the shard-4 flake of #440 has a name
now, `task-tree-kill`'s "a timeout reaps the grandchild", a 300 ms
window a loaded macOS runner outran (#445), two seconds since; a probe
whose negative case contains the positive's needle ("broken" holds
"ok") proves nothing — check the negative case before reading the
result. Methods that paid: the pages a newcomer copies from are
compiled, not read (284); a divergence a parity suite pins as
documented is still a divergence the guides may contradict — read the
guides against the suite, not the reference alone (287); a CI failure
you cannot name gets its name from the next occurrence — keep the
shard's file list. Next: the lockfile persona — a dependency bump under
`bun()`, `vx why` naming the claim and `--affected` following it — and
`vx init` on the walkthrough repo after 287, to read what the TODO says
about `--affected` now. Never end with "what next?".

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
    third repo shows the addition shape, with the design note first
    (`docs/design/`), and leave the rewrite refused.

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
