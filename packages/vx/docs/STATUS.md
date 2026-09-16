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
(handoffs 14w–14y to the next-log file), so this file stays the handoff
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

306.  DONE (2026-09-16, the trim 14aa named): items 282–305 moved
      whole to `docs/history/2026-09-improvement-loop-282-305.md` and
      handoffs 14w–14y to `docs/history/2026-09-status-next-log.md`,
      the record paragraph and every earlier history head repointed,
      each removed line checked present in its new file before the
      write. The loop holds this entry; 14z and 14aa stay as the
      current handoffs.
307.  DONE (2026-09-16, 14aa's named next: the module pages' "Public
      surface" blocks against their modules). A probe over the 68
      pages that have one (247 names) found four stale: config-imports
      documented `scanLocalImports`, a function the module has not
      exported since the channel was rewritten (its real surface is
      `unprovidedBareImports` and `configImportOwners`);
      execute-task still declared the hash trio that moved to
      `task-hash.ts`; stable-keys listed two internal helpers as
      public; task-graph declared `ProjectEntry`, which the workspace
      module owns. Fixed, and the law is `tests/module-surface-drift.test.ts`:
      the index maps each page to its files, and every name a block
      declares must be exported there (a bullet may name a member).
      Fails on the old pages.
308.  DONE (2026-09-16, comparison.md's flag map against the parser):
      the vx column held; the callout under it still named the
      retired `--excludeDependencies`, and one cell wrote `--timeout`'s
      value as a duration (it takes milliseconds). Pinned beside the
      table pin: every flag the section's vx cells and callouts name
      is a parser flag. Fails on the old page.
309.  DONE (2026-09-16, comparison.md's gap audit and running list
      read against source): the audit's "verified present in core"
      still listed `prune` (removed 2026-09-11) and `migrate` (its own
      package since 2026-09-10); the "shipped since" pipeline bullet
      named five of thirteen hooks (pinned to `PLUGIN_HOOKS` now,
      beside the tables); the daemon rejection quoted a 240 ms warm
      1000-project run the benchmarks page has at 172 ms. The
      shipped/rejected/out-of-scope lists otherwise read true.
310.  DONE (2026-09-16, `optimizations.md` read against source): the
      catalog cited `execute-task.ts` for the hashing rows (three of
      them; it is `task-hash.ts` since item 16), `execute-task.ts` for
      the git-snapshot invalidation (`miss-save.ts` and
      `hit-restore.ts`), a `cache/remote-cache.ts` that does not exist,
      `layered-cache.ts` for `Bun.Glob` (zero uses; `inputs.ts`), and
      "the CLAUDE.md decision log" (retired 2026-09-02); two "known
      headroom" entries had shipped — the batched all-hits probe
      (#17d) and the per-run `taskConfigHash` memo (#5). Every
      citation is module-qualified now and the pin in
      `tests/doc-references.test.ts` holds each `module/file.ts:symbol`
      to an existing file and symbol, and refuses a bare basename.
      Fails on the old page.
311.  DONE (2026-09-16, item 304 re-read against `wire.ts`): 304
      removed the remote-execution guide's "retry once at 64 KB"
      bullet as a Bun 1.3 leftover. It is live code: `writeResource`
      catches a `DEADLINE_EXCEEDED` on a multi-message write and
      retries once at `SAFE_CHUNK_BYTES` (65535), because the Bun
      http2 flow-control defect is a race above the RFC 7540 initial
      window, not a boundary. A grep for `retry` missed `retries`
      and called it gone. The bullet is back, stating the trigger and
      the size, and pinned in `tests/site-samples.unsafe.test.ts` to
      `CHUNK_BYTES` and `SAFE_CHUNK_BYTES` read from the wire's
      source; 304's record and 14aa are corrected in place, and
      CLAUDE.md has the rule: grep every form of the word and the
      constant's name before calling a documented behaviour gone.
      Also fixed in passing: a code span in CLAUDE.md wrapped across a
      continuation line (the root is outside `lint.oxfmt`'s scan, which
      runs in `packages/vx`, so nothing caught it). Fails on the page
      304 left.
312.  DONE (2026-09-16, the three site pages the series had not read:
      quickstart, add-to-existing-repo, parity). The quickstart's hit
      comment showed a glyph no source file prints (the row is glyph,
      time, status, cache, name: a local hit opens with the local
      arrow and reads "success local") and called `--graph` "text or
      Graphviz DOT" (DOT only, as `vx help` says); the adoption page
      gave the concurrency default as the raw core count (the help
      says the cores this process may use — a cgroup quota caps it);
      parity's "Reading the map" still counted changed-not-dependents
      among the divergences (#446 closed it) and pointed
      cleaned-not-additive at the section that does not record it.
      `docs/modules/framed-output.md`'s two one-liner samples showed
      the same invented shape. Fixed; pinned: the quickstart glyph and
      words are `formatTaskHitLine`'s and the flag comments are the
      help's (`tests/site-samples.unsafe.test.ts`); every `tests/` and
      `packages/` deep pin parity cites exists and its Turbo/Nx
      versions are the suites' (`tests/doc-references.unsafe.test.ts`);
      the one-liners' shape and the module page's samples
      (`tests/framed-output.test.ts`, which had never called either).
      Five fail on the old pages.
313.  DONE (2026-09-16, 14ab's named next: the module pages whose
      source moved after the page, widest gap first — plan-format,
      run-report, events). plan-format.md's text sample had a
      "no-cache — opts out" row the formatter words "(would exec)",
      a group row the text form hides, and a four-task plan summed
      as three; its placement sample padded a column the formatter
      does not; its JSON sample put `description` before `hash`; its
      DOT sample was a document the formatter never wrote (another
      graph name, a Helvetica node default, status words for labels,
      a different green); and none of the `predicted:` footer, the
      `download:` block or the wire's optional fields was on the page.
      The module's own docblock joined the summary with a colon and
      printed one decimal (a comma, two). events.md still sent
      `WireEvent` to "serve delegation, dev sockets" (569dd17 removed
      both; nothing in core consumes it) and had "Web/TUI/MCP
      surfaces" on the bus (`@vzn/vx-mcp` reads history), and named
      none of the outcome vocabulary or the wire views it exports.
      run-report.md read true (its five commits since were label
      changes the page never quoted). Fixed; pinned: every sample on
      plan-format.md is the formatter on one fixture
      (`tests/plan-format.test.ts`, four fail on the old page); the
      names events.md now declares are held by the surface law.

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
    270, 275, 281, 287 and 293 (14–14y) are in
    `docs/history/2026-09-status-next-log.md`; 14z–14ab below are
    the current ones.

14z. **Handoff after item 299 (2026-09-16, evening).** Six items
since 14y, the read-against-source series: architecture.md's nine
stale claims and six pins, comparison.md § Where vx is ahead found
true (294, #449); the telemetry page's version quote and the cloud's
2.6 MB of screenshots removed (295, #449); execution.md's nine and
two pins (296, #450); flows.md and patterns.md, the citations turned
from `file:line` to file + phrase and pinned (297, #451); caching.md's
schema block, five of ten tables missing, pinned to the source (298,
#451); schema.md's `plugins` bullet, ten of thirteen hooks and
backtick soup on the site, and history.ts's header (299, #452, open).
Open: Next 1, 2 and 16, all gated by their own terms; In-flight 5
(macOS); the owner residue — the `NPM_TOKEN` secret, the release cut,
the site's address. No open issues. The loop holds eighteen items
(282–299); the next trim moves 282–299 to history when 14z's
successor lands. The box: as 14y; quoting broken markup inside STATUS
breaks STATUS — an unbalanced backtick un-indents the item under the
formatter (299, first try; describe the breakage, never paste it); a
slash-separated list escapes a backtick grep, so a class grep names
the words too (296 found the dispatch list 294's grep missed); the
formatter's verdict names the file on the line above "Format issues
found" — a chain can read it and reformat that file (299); a comment
block above a `CREATE TABLE` stacks silently when a table is inserted
between them (cache.ts's `output_dirs` comment sat above
`config_closures`, 298). Methods that paid: a page is read in the
order a reader is sent to it (the overview's "Where to start" table),
whole, every claim against source, the numbers against
benchmarks.md; every list in prose with a source gets a pin the same
commit, and every pin its differential; a `file:line` citation is a
lie in waiting — cite the phrase and pin the phrase. Next: the last
reader pages the same way — cli.md against the help text and the
verbs' parsers (1,900 lines; the drift pins cover the samples, not the
flag tables), comparison.md's flag and schema maps against Turbo and
Nx's current docs, benchmarks.md's prose against its own tables — and
then the site's guides (running-tasks, remote-caching, sandboxing,
plugins) against source the same way. Never end with "what next?".

14aa. **Handoff after item 305 (2026-09-16, evening).** Six items
since 14z, the read-against-source series finished: cli.md's flag
table against the parser and `vx help` (four flags the help never
named, 300); benchmarks.md's two contradictory 46-package tables
(301); the site's seventeen guides in three passes (302–304: the
run-flags table's `--force` claim, `--graph` as text in three places,
the dev-server teardown, the env allowlist, the reapi "in time,
executor", and one wrong call, the "64 KB retry" that does exist,
corrected in 311); and the
introduction, migration and concept pages (305: a botched splice on
the front page, `admit` missing from the table, `nx affected` still
mapped to the changed-only filter). 300–301 went in #452, 302 in
#453, 303 in #454, 304 in #455, 305 in #456 (open). Open: Next 1, 2
and 16, all gated by their own terms; In-flight 5 (macOS); the owner
residue — the `NPM_TOKEN` secret, the release cut, the site's
address. No open issues. The loop holds twenty-four items (282–305);
the next trim moves 282–305 to history. The box: as 14z, and the
same lesson three times in one evening — an entry that quotes broken
markup, or lets a code span wrap onto a continuation line, breaks
STATUS under the formatter, and a chain that prints the scan's
verdict instead of gating on it commits the breakage (299, 304, 305:
describe the breakage in words, gate every chain on `rc`); oxlint
refuses a path with `..` — lint a sibling package's file from that
package's directory (305); a `--dry` sample that already matched
still earned its pin, and rendering it found the formatter's own
docblock wrong (302) — render the sample even when it looks right.
Methods that paid: the series' yield held to the last page (fifty-odd
stale claims over eleven items, a pin behind every list), and the
cheapest probe of a page is its own build output (`dist/`) or its
own formatter (`formatPlanText`, `renderJobSummary`), never a
re-read. Next: the trim (282–305 to history, the record paragraph
and the pointers); then Next 6's re-measure is due only when warm-
path code moves (none did this evening); then the design/ pages are
dated records and stay, but `docs/modules/*.md`'s "Public surface"
blocks are the one doc class this series never read against source
— a pin that each block's exported names exist in the module is the
same law as the inventory pins, forty pages wide. Never end with
"what next?".

14ab. **Handoff after item 312 (2026-09-16, evening).** Seven items
since 14aa: the trim (306: 282–305 and 14w–14y to history, STATUS
from 800-odd lines to 472); the module pages' "Public surface"
blocks as a law (307: four stale of 247 names, the pin maps each
page to its files through the index); comparison.md's flag map,
gap audit and running list (308–309: the retired
`--excludeDependencies`, `prune` and `migrate` still "in core", five
of thirteen hooks named); optimizations.md's citations (310: every
one module-qualified now, a bare basename refused); the one
correction of a correction (311: 304 struck the remote-execution
guide's upload retry as a Bun 1.3 leftover and it is live code — a
grep for `retry` that missed `retries`); and the three site pages the
series had never read (312: a hit glyph no source prints, `--graph`
"text or DOT", a divergence #446 had closed). 306–310 went in #456,
311 in #457, both merged; 312 is #458 (open). Open: Next 1, 2 and 16,
gated by their own terms; In-flight 5 (macOS); the owner residue —
the `NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 306–312. The box: a negative grep is a claim
about every spelling of the word (311; CLAUDE.md has the rule); an
edit script that fails to parse writes nothing, and the chain after
it read a clean tree as "differential fails: 0" — the script's exit
and the stash's "No stash entries found" were both in the output,
read the whole output before the verdict line (311); the repo root
is outside `lint.oxfmt`'s scan, so a wrapped code span in CLAUDE.md
sat unflagged until a root scan (311); a rendered sample is only
half the method — grep the source for the glyph a page shows, and a
glyph that appears in no source file is the finding (312). Methods
that paid: re-reading a correction against the source it corrected;
merging a green PR by API while the local gate runs on the next item
(the queue stays one deep at no cost); `git log -1` on a module page
against its source lists the pages whose module moved after the page
was last touched — the probe for the next item. Next: those module
pages, prose against source, starting where the gap is widest
(plan-format, run-report, events, cli-cache, inputs, scheduler,
prepare, summary, cli-help); then Next 6's re-measure only when
warm-path code moves (none did today); the blog posts are dated
records and stay. Never end with "what next?".

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
