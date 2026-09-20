# Shipped, 2026-09 — improvement-loop items 282–305

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`; items 333–352 in
`2026-09-improvement-loop-333-352.md`; items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 373–392 in
`2026-09-improvement-loop-373-392.md`; items 393–412 in
`2026-09-improvement-loop-393-412.md`; items 413–432 in
`2026-09-improvement-loop-413-432.md`; items 433 onward continue in
`docs/STATUS.md`.

## Improvement loop (2026-09-09, after the review pass merged)

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
288.  DONE (2026-09-16, the lockfile persona 14x named): a fresh
      two-package workspace declaring `bun()` from `@vzn/vx-lockfile`,
      `lib` depending on a real npm package and `app` on `lib`,
      installed and committed; the dependency bumped and reinstalled.
      `--affected=HEAD` selected both (`2 affected · 2 total` — the
      manifest change and, through 287, the dependent); `vx why` on
      lib named the changed manifest and the changed plugin part,
      `@vzn/vx-lockfile/bun`, with the part's digests, and on app the
      plugin part alone, its closure reached through lib — the shape
      Next 8(g) records (digests, not material); `vx info` lists the
      plugin with its seams, `key, fingerprint`. Every surface read
      right; nothing to fix. The probe's own lesson: a foreign
      workspace cannot install a workspace package through `file:` or
      `link:` when that package's own dependencies are `workspace:*`
      (`@vzn/vx@workspace:* failed to resolve`), and `bun install`
      wipes hand-placed symlinks — install the real dependency first,
      then symlink the plugin packages, after every install.
289.  DONE (2026-09-16, after 287, the CI guide read once more): its
      opening said a pull request "restores everything else from a
      previous build" and its `--affected` note "the rest restore from
      cache" — under `--affected` the rest are never scheduled, so
      nothing is restored or probed; what a previous build already
      produced is a hit within the selection. Both sentences say so.
      And four of 14x's box entries moved to CLAUDE.md's rules learned
      the hard way, where every session reads them: the edit script
      that writes before it asserts, the item inserted before the
      blank, the type-checker's `node_modules` walk, the probe whose
      negative case held the needle.
290.  DONE (2026-09-16, the class 287 opened, grepped): six more
      surfaces still described `--affected` as "only what changed" —
      the quickstart, the adoption page, the running-tasks guide (its
      comment, its description and its heading), the CI guide's
      description and step 3, the remote-caching guide twice (which
      also promised "downloads everything else", 289's mistake), and
      the root README's command list; each says "and what depends on
      it" now, and the remote-caching guide says the rest are never
      scheduled. The heading rename found a broken anchor: the guide's
      link to the running-tasks section had one hyphen where the built
      id has three (github-slugger keeps `--affected`'s dashes), and
      a sweep of every anchored link on the site and in the core docs
      found four more (`--summarize-path`, `gaps-for-vznvx`, two
      README headings that no longer exist). Two laws now: every
      `](x.md#anchor)` in the core docs and every `](../page/#anchor)`
      on the site names a heading by its rendered id
      (`tests/helpers/markdown-anchors.ts` is the slugger; the site's
      generated pages resolve to their source). The README's § 5 also
      claimed a workspace that declares no plugin "fails before any
      task runs" — the floor has run and cached since 2026-09-10, and
      the same file said so 60 lines later; it says the floor now.
291.  DONE (2026-09-16, 290's law widened to every relative link):
      the anchor laws read only `](x#anchor)` links; a probe of every
      relative link in the core docs and on the site (201 and 194)
      found one page that does not exist — the technical README linked
      `@vzn/vx-reapi` as `../packages/vx-reapi`, which from
      `packages/vx/docs` names nothing and on the site rendered as
      `/vx/packages/vx-reapi`, a 404 on the overview page since the
      package moved. It links the repository now. Both laws now hold
      every relative link: the page must exist (a link with an
      extension is a file beside the page), and an anchor must name a
      heading. STATUS is outside the law (it quotes the patterns).
      14x's other named next, `vx init` after 287, closed by a grep:
      the scaffold says nothing about `--affected`.
292.  DONE (2026-09-16, the hook list's two prose copies): the
      technical README's § 5 said "a hook at every stage" and named
      eight of thirteen (no `config`, `fingerprint`, `admit`, `setup`,
      `teardown`), and CLAUDE.md's "Pipeline stages a plugin can fill"
      line named ten. Both name all thirteen in pipeline order now,
      and the hook-drift pins hold them: the § 5 paragraph in the safe
      suite beside the tables, CLAUDE.md in a new unsafe half (the
      repository root is outside the project). Each fails on the old
      prose.
293.  DONE (2026-09-16, the evaluator persona: the technical README,
      the site's overview page, read whole against source after 290
      and 292 found two stale claims in one section of it): four more.
      The benchmark numbers came "from `bench/`" (the harness has been
      `packages/vx-bench/` since the move); the layout said "the root
      member is core" (core is `packages/vx`, a sibling of the
      plugins), "eight modules" with a `plugins/` row (seven
      directories; the floor lives in `exec/` and `cache/`, and the
      rows say so now); and the plugin-package sentence named three of
      seven published packages, with a "+" that a wrap had turned into
      a bullet, so the overview page rendered "(Bazel remote cache"
      and a one-item list. All seven are named. `modules/affected.md`
      rule 4 still said a changed root lockfile selects every project
      — true only for a lockfile no plugin claims, and the page never
      mentioned the claim; it does. Two pins: the layout table's rows
      are exactly the `src/` directories and the count sentence agrees
      (safe half); the published-packages sentence names each
      non-private `@vzn/vx-*` sibling (unsafe half, `packages/` is
      outside the project). Both fail on the old README. Also read and
      found true: the outputs-wiped-before-restore claim, the three
      channels, `vx cache prune`, `readyWhen`, every number in "What
      that buys" against benchmarks.md.
294.  DONE (2026-09-16, 14y's named next: the two pages the overview
      sends a ten-minute reader to, read whole against source).
      `comparison.md` § Where vx is ahead: every claim true (the
      worker re-evaluation, the query-string bust on the entry, the
      prefetch, `vx lock --check`, `--profile`, the group-task
      exclusion from `runs`, the cache-on-persistent refusal,
      `Bun.YAML` / zstd / xxHash3 in source). `architecture.md`: nine
      stale claims — "the root package is `@vzn/vx`" and a `.` (root)
      row (core is `packages/vx`); three of nine packages missing from
      the table; "~80-symbol public API" (42 runtime symbols, the
      snapshot); the orchestrator inventory named two files that do
      not exist (`predict.ts`, `remote-cache-setup.ts`) and missed
      seventeen that do; `TELEMETRY_SCHEMA_VERSION = 1` (2 since the
      usage fields); a `POST /v1/ingest` from the removed cloud; the
      dispatch list named `mcp` as a core verb and lacked `why`,
      `last`, `completions`; the `--affected` sugar as `[<base>]`
      (287 missed this copy); "declares `otel()` alongside the local
      executor and cache" (five plugins, and the floor is implicit —
      `vx.workspace.ts`'s own comment said "nothing runs that is not
      declared here, including core's own executor and cache", stale
      since 2026-09-10, corrected); the `runs` column table listed
      twelve of twenty-one. Five pins in `tests/architecture-doc-drift.test.ts`
      (inventory = `src/orchestrator/*.ts`; the telemetry version;
      the dispatch sentence = the `case` list of `cli/index.ts`; the
      column table = `CREATE TABLE runs`; the API count = the façade's
      runtime keys) and one in its unsafe half (one row per
      `packages/*`). All six fail on the old page.
295.  DONE (2026-09-16, 294's class grepped across every doc surface):
      `modules/telemetry.md` quoted `TELEMETRY_SCHEMA_VERSION = 1` too
      (the version pin now reads both pages), and
      `packages/vx-docs/src/assets/screenshots/` — 2.6 MB of dashboard
      baselines and a README that tells the reader to run
      `packages/cloud/tests/visual.test.ts` — had outlived the cloud
      removal (2026-08-23) by three weeks, referenced by nothing on the
      site. Removed. The other seven patterns of the class (root
      package, `[<base>]`, the phantom files, `/v1/ingest`, the
      workspace's "alongside the local executor", the API size, `mcp`
      as a verb) hit nothing outside design/ and history/, which are
      dated records.
296.  DONE (2026-09-16, `execution.md` read whole against source, the
      third page of the series): nine stale claims — the dispatch
      list (`mcp` as a core verb; no `why`, `last`, `completions`;
      the class grep missed it because the list is slash-separated,
      not backticked); the workspace fingerprint "over every supported
      lockfile" (minus a claimed one); "all four steps" of a
      three-step list; "a service run" supplying the `inflight` map
      (the service is gone; an embedder may); `--excludeDependencies`
      (retired; `--exclude-dependencies[=names]`); "full stdout text
      is stored" (the first and last 8 MiB since 229); the glyph
      grid without `⦿` running; the essential allowlist naming eleven
      of seventeen POSIX names; "anything not in these four layers is
      invisible" (vx sets `VX_RUN_WORKSPACE` and `VX_RUN_TASK`
      itself). Two pins in `tests/execution-doc-drift.test.ts`: the
      dispatch list = the `case` list, the allowlist sentence ⊇
      `ESSENTIAL_ENV`'s POSIX names. Read and found true: the kill
      grace (2 s), the 30 ms redraw floor, the `--dry` outcome set,
      the `--dry` + `--summarize` refusal, `::group::`, the workspace
      config's four fields, the concurrency default.
297.  DONE (2026-09-16, `flows.md` and `patterns.md` read whole against
      source). flows: the up-to-date check's owner (`hit-restore.ts`,
      not cache.ts); the sandbox flow's Linux branch ("child sees
      ENOENT, usually fails itself" — an strace pass reports the
      denied calls, and both platforms share the gate; the sandbox
      module page said the same, corrected); `--dry` "bumps
      `accessed_at`" twice (it probes with `has`, which does not — the
      plan path is read-only by design, cache.ts says so). patterns:
      fourteen `file:line` citations, eight past the splits that
      moved them (`CacheKeyInput` to `layer.ts`, the package.json fold
      to `task-hash.ts`, the bin PATH to `exec/env.ts`, the replay to
      `hit-restore.ts`), two quoted phrases that appear nowhere
      ("Turbo / Nx model", the `$TURBO_DEFAULT$` line), "~20 lines"
      for a grep that returns 49, and a 2026-05 performance table
      (`+2.95 s`, `159 ms`) beside the 2026-09 numbers every other
      page carries. Citations are file + phrase now, and
      `tests/patterns-doc-drift.test.ts` holds each phrase to its file
      and refuses a line number. Both pins fail on the old page.
298.  DONE (2026-09-16, `caching.md` § SQLite tables read against
      `cache.ts`): the block headed "src/cache/cache.ts schema"
      documented five of the ten tables — no `config_evals`,
      `file_hashes`, `output_files`, `config_closures`, `output_dirs`,
      the machine-local memos every warm run reads — while the prose
      named three of them as if the block had. All ten are in the
      block with the why of each, and the pin holds the block to the
      source: the same table names, and each table exactly its
      columns (the five documented ones already matched). The source
      had the `output_dirs` comment stacked above `config_closures`'s
      table; moved to its own. The rest of the page's storage
      section (the artifact layout, the sidecar, the streaming save
      and restore, the index-is-authoritative rule) read true.
299.  DONE (2026-09-16, `schema.md` § Workspace config and the module
      index read against source): the `plugins` bullet named ten of
      thirteen hooks (no `fingerprint`, `admit`, `teardown`) and its
      code spans had wrapped across continuation lines, so the site
      rendered the executor and telemetry clauses and the first-party
      list as run-together backtick soup (item 280's formatter rule,
      on a page a config author reads). Rewritten in pipeline order
      naming all thirteen and the seven first-party packages, no span
      across a line, and pinned to `PLUGIN_HOOKS` beside the table
      pins. The header of `history.ts` said the scheduler and a
      `vx info --history` flag read it (the `schedule` plugin and the
      `--dry` prediction do; no such flag) and promised a remote
      provider "when such an RPC exists" (the service is gone; the
      interface is the seam). The module index read true row by row.
      The lesson, again: quoting broken markup inside STATUS breaks
      STATUS — an unbalanced backtick un-indents the list item under
      the formatter (this entry, first try).
300.  DONE (2026-09-16, 14z's named next: `cli.md` § Flags against
      the parser and the help text). The table already matched the
      parser (its pin); the help did not: `vx help` never mentioned
      `--continue`, `--report`, `--report-file` or `--tag`, four flags
      the parser accepts and the reference documents, and the
      `--output-logs` flow note ("focused without --all…, broad with,
      full in CI") sat indented under `--download`, describing the
      wrong flag. All four are in the help, the note under its flag,
      and a pin holds the help to the parser's flag set beside the
      table's. The table's `--affected` row still read "changed
      since" (287 swapped the section, not this row); it says
      dependents and the sugar now.
301.  DONE (2026-09-16, `benchmarks.md` prose read against its own
      tables): the page carried two 46-package head-to-head tables
      with opposite verdicts on the warm row — the 2026-09-03 one
      (Turbo 71 ms, vx 76 ms, "read it honestly: within a few
      milliseconds") and an older one below it (vx 127 ms, Turbo
      245 ms, "vx is 1.9× faster than Turbo") that a "predates both"
      aside kept but a reader would quote; the older table and its
      reading are gone, the paragraph says why. The Wave 2 breakdown
      read "where the remaining 242 ms goes" under a table whose last
      column says 172 ms; it is dated to its wave and says what the
      later waves took off. The stress section is generated
      (`update-site.ts --check`) and untouched; the real-repo
      sections are dated records and read as such.
302.  DONE (2026-09-16, three site guides read against source:
      running-tasks, sandboxing, remote-caching). running-tasks: the
      run-flags table said `--no-cache` (`--force`) "don't read or
      write" — `--force` keeps writes on, the whole point of it; two
      rows now, with `--concurrency`'s default (the cgroup-capped
      cores) and `--output-logs`'s `hash-only` mode; and `--graph` was
      "the task graph (text)" (Graphviz DOT to stdout). The `--dry`
      sample matched the formatter byte for byte — the probe that
      rendered it found the formatter's own docblock showing a glyph
      it never writes (`✓` for a local hit; it prints `◉`), corrected
      — and the sample is now rendered by `formatPlanText` in
      `tests/site-samples.unsafe.test.ts` and compared byte for byte
      (a mutated glyph fails it); the site's own tests reach only the
      public API, so the pin lives in core's unsafe half. sandboxing
      and remote-caching read true against `sandbox-runtime.ts` and
      `@vzn/vx-reapi` (the env names, the 128 KB chunk, the
      `vx-reapi-v1` action prefix, the optional strace).
303.  DONE (2026-09-16, nine more site guides read against source:
      plugins, caching, dev-tasks, task-dependencies, tasks,
      environment-variables, workspace-config, lockfiles,
      trusting-the-cache). Stale: "the three stage hooks" (seven);
      the cache-layer refusal's method list read as the whole
      contract (fifteen methods, pinned to `CACHE_LAYER_METHODS`);
      `--graph` as "text or DOT" in three places (DOT only); "vx needs
      no plugins or executor protocol" (it has the executor seam; what
      it has no protocol for is the command); dev-tasks' teardown
      bullet, which torn down every persistent task when the graph
      finished — a requested one keeps the run alive, the point of
      `vx run dev` since the keep-alive change; the env guide's
      allowlist naming eleven of seventeen POSIX names (pinned to
      `ESSENTIAL_ENV` like execution.md's) and silent on
      `VX_RUN_WORKSPACE` / `VX_RUN_TASK`; the lockfiles guide's
      "2 of the gate's 61 tasks" (a count the gate outgrew the week
      it was written; no count now); and the caching guide's "~620 ms
      to ~20 ms on this repo's benchmark" (no such benchmark; the
      3,270-task numbers, dated). workspace-config, lockfiles' claim
      model and trusting-the-cache's `vx why` sample read true.
304.  DONE (2026-09-16, the last four site guides read against their
      packages: mcp, otel-bridge, extensibility, remote-execution).
      extensibility said `@vzn/vx-reapi` fills `cache` "and, in time,
      `executor`" (it has since the remote-execution arc, behind
      `execute: true`), listed no first-party plugin for the execute
      and store rows, and closed with "even core's own executor and
      cache obey it — they import core through the public `@vzn/vx`
      specifier" (the floor is in core, not a plugin, since
      2026-09-10). remote-execution promised uploads "retry once at
      64 KB if the transfer stalls", and this item removed the claim
      as Bun 1.3's ceiling — wrongly: `writeResource` retries a
      deadline on a multi-message write once at `SAFE_CHUNK_BYTES`
      (65535), and a grep for `retry` that missed `retries` called it
      gone. Item 311 restored it, pinned to the wire's constants. mcp
      (the six tools, the
      hundred-line transport: `server.ts` is 144) and otel-bridge
      (every option, default and attribute name in `otlp.ts`) read
      true. That closes the site's seventeen guides; the series
      (294–304) found fifty-odd stale claims across twelve pages and
      left a pin behind each list. And this entry broke STATUS on its
      first try: a code span wrapped across a continuation line, the
      formatter un-indented the line, and a chain that printed the
      format verdict instead of gating on it committed it — CLAUDE.md
      has both rules; read them before writing an entry.
305.  DONE (2026-09-16, the site's introduction, two migration pages
      and two concept pages read against source). The introduction's
      schedule-history bullet ended in a botched splice — half a
      sentence and a stray backtick from a removed line beneath it —
      live on the front page; its stage table
      lacked `admit` (the site's hook pin covered the extensibility
      table only; it covers this one now); its `@vzn/vx-migrate` link
      went to the remote-caching guide; and "still faster cold than Nx
      is daemon-warm" is false on every table the benchmarks page
      holds (a cold run is the tasks). from-turborepo said Bun ≥ 1.3
      (1.4) and sent a Turbo-cache user to write a plugin
      (`turboCache()` reads `TURBO_TOKEN` already). from-nx mapped
      `nx affected` to the changed-only filter with a note that
      `--affected` "alone is the changed set" (287 made it the
      dependents too; the class grep missed this copy because it was
      a table cell), and Nx Cloud to "the Turborepo wire" (`nxCache()`
      keeps a self-hosted Nx cache). how-vx-works' stage 5 now names
      `admit`. why-vx-is-fast's numbers match the benchmarks page.
