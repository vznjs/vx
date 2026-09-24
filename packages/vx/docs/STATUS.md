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

721.  DONE (2026-09-24, the site redo R1–R3, `design/site-redo-2026-09.md`).
      The site is one story now. Four places (Guide, Docs, Reference,
      Blog), each with its own sidebar (`src/nav/sections.ts`, filtered
      per page by a Starlight route middleware); internals leave every
      sidebar for one `internals/` page; the landing's lime look site-wide
      through `--vx-*` tokens, dark by default. The Guide is ten written
      chapters on the four toy packages (why, tasks, dependencies,
      concurrency, caching, trust, affected, many machines, inside vx, try
      it), 80–260 words each, three to five pictures each, a chapter
      header and a one-line Next card from `src/guide/chapters.ts`. Every
      picture is one build-time component (`components/guide/diagram/`,
      data per chapter, tokens only, no script, whole on a phone), and
      `diagram-kit.test.ts` holds each label to fit its box.
      `tests/guide-page.ts` holds every chapter's shape (titles, pictures,
      ≤350 prose words, "In vx" as one sentence plus one block plus a
      collapsed proof list, one question, the four packages only, no
      competitor outside "In vx"), and each picture that states a fact is
      held to vx's own model. The Docs are one short page per job (goal,
      steps, config, common problems, a link to the chapter that says
      why; prose cut 70–90%), five pages merged with redirects
      (introduction, trusting-the-cache, task-dependencies, extensibility,
      concepts/how-vx-works). The landing is the Guide's cover: one
      question, a picture of the shell loop failing three ways, "Read the
      guide", the ten chapters as contents, then the numbers. The
      playground's fifth package is the task `app#docs`, so every page
      names four packages. Gate: `ci --all` 56/56 and a Node build of 255
      pages, 587 site tests.

722.  DONE (2026-09-24, Next 16 a, d, e, f). The old Learn pages are
      gone: seven redirect to the chapter that teaches the same idea, the
      labs move whole to `guide/labs` (a tool page chapter 10 links, lab 4
      with its own simulator), the choosing page is the Reference's "vx,
      Turborepo, Nx, Bazel" at `compare/`, the glossary is `glossary/`;
      `redirects.test.ts` holds all ten targets. Old rows went only where a
      chapter row already holds the same widget. Chapters 4, 6 and 8 draw
      their last text sections (the start order from the simulator's
      model, 27 s against 24 s; four things outside the sandbox's wall;
      the four costs). Ch 9's problem no longer says "vendor", ch 3 lost
      its forward reference and `chapterShape` refuses a chapter that
      names another by number, ch 7 keeps one idea per section. Six Docs
      pages trimmed with every pinned fact kept. Gate: `ci --all` 56/56;
      the unsafe doc laws pass with the generated pages hidden (darwin's
      shape).

723.  DONE (2026-09-24, Next 16 b, c). The widgets take the pictures' look
      through one stylesheet (`demos/widget.css`: the picture's frame and
      caption, mono data, one corner, two strokes, `--vx-*` tones), held by
      `diagram-kit.test.ts`; the graph explorer is drawn by the diagram kit
      itself. Visible text is cut 45–85% per widget: the key calculator is
      one table (task, key, runs or hit) plus five edit buttons; each
      checkpoint is one sentence of at most twelve words (chapter 6 asks
      about app's `banner.txt`; chapter 3's `app#build` question is a
      planner-checked checkpoint). The playground runs `build test` again
      with `app#docs` declared outside it, and chapter 10's command is
      `vx run build test --all --dry` (a bare task at a workspace root
      refuses), both held by rows. Three unused components and two
      unplaced checkpoints went. Every widget row that ties a model to
      real vx is kept.

724.  DONE (2026-09-24, Next 16). Every Guide picture reads on a phone.
      Read at 390 px, each 600-wide picture shrank to the column and set
      its type at 7-9 px, and the scheduler's charts scrolled sideways
      with nothing to say more was there (their phone form is item 725).
      A picture now carries a phone
      layout (`narrow`, at most 360 across): the same boxes, arrows,
      frames and words, laid out tall, shown below 32rem at 13-14 px.
      `diagram-kit.test.ts` holds that every picture wider than a phone
      has one, that it fits, and that it says what the wide one says (a
      note may break across lines; a lone arrow glyph points the way its
      layout runs); `guide-page.ts` reads both drawings back against
      their data. `lanes({ down: true })` runs a timeline down the page.
      The cover's shell line is text
      above a 410-wide drawing, the graph explorer has a phone layout
      from its model, and code blocks wrap. The site plan's "Done means"
      is rewritten for the Guide, each line naming its test.

725.  DONE (2026-09-24, Next 16). The scheduler simulator's Gantt charts
      read on a phone: `ganttSvg` draws each chart twice, time across and
      time down the page (one column per worker, 340 across, one scale for
      both charts of a pair), and a container query at the wide chart's
      own 34rem minimum picks one, so the chart's box decides and no width
      scrolls sideways (a viewport breakpoint had left 513-585 px where the
      wide one overflowed). `guide-concurrency.test.ts` holds the phone
      chart to the wide one's bars, classes, titles, lines and label, and
      the built CSS to the container query.

726.  DONE (2026-09-24, Next 17 step 2). A sandboxed task that declares
      `cache` is granted a linked workspace package only when its key
      already answers for it. `sandboxRequestFor` takes the run's keyed
      set (`orchestrator/keyed-projects.ts`: the projects of every exec
      task the key folds, walked through `upstream.ts`'s
      `selectFoldedDeps`, the one copy of the `cache.inputs.tasks`
      matcher, memoized per run, so a run of hits walks nothing). Every
      other link target inside the root is withheld and reported
      (`ExecuteSandbox.reportLinked`, read by `withinReported`), with one
      hint line naming the package, the link and the edge that would key
      it; an uncached task keeps the whole grant. The design's rule 5
      counted only cached tasks, on the claim that an uncached task's
      hash folds no files; the key-level rows refuted it (no `cache`
      means no `inputs.files`, so `**/*`: an edge to one moved the key on
      a README edit, on both key paths), so K(T) counts every exec task
      the fold reaches and a persistent task none. Rows:
      `sandbox-request.test.ts` (exact grant and report sets, canonical
      and symlinked root), `keyed-projects.test.ts` (R3 on hand-built
      graphs; R4 against `run()`'s real keys in eight shapes),
      `sandbox-runtime.unsafe.test.ts` (both link layouts, a symlinked
      root, the `^source` and uncached controls, both hint shapes);
      sixteen mutations, each caught. `CACHE_VERSION` v31, probed: an
      entry saved before it replayed the old sibling under v30 after the
      sibling changed. Cost: K(T) for all 2,000 exec tasks of vx-bench's
      1,000-package workspace is 0.28 ms (18 ms with `build → ^build`);
      the gate A/B is flat (warm min 0.49 → 0.51 s, the residue in
      `check.bun`'s spawn). This repo went red nowhere. Found on the way:
      item 727.

727.  DONE (2026-09-24, Next 17). A task downstream of a persistent task
      had two keys: the local classify pass (`stable-keys.ts`) hashed the
      persistent dependency and the live path (`--force`, a remote cache)
      folded nothing of it, so a `--force` or remote run saved entries a
      plain local run never probed. The classify pass now skips a
      persistent task as the live path does. `keyed-projects.test.ts` R4
      holds both paths to one key in all eight shapes and to the same
      movers (the local check had been a superset); without the fix the
      persistent shape reads two keys. No `CACHE_VERSION` bump: only the
      local key of such a task moves, its old entries become misses, and
      no stored bytes are wrong.

728.  DONE (2026-09-24, Next 16). The sandboxing guide in plain words:
      step 2 says a linked package of yours is readable when the task
      depends on one of its tasks (726's rule without its terms), and
      "What can't be sandboxed" drops this repo's own tally of the two
      tasks that decline the sandbox, which a reader does not need; the
      row that holds CLAUDE.md's count against the configs stays, its page
      half gone.

729.  DONE (2026-09-24, Next 16, `design/site-short-2026-09.md`). The site,
      short. The landing is the story: one line, one diagram (`one-run`:
      the toy build after an edit to app, with six callouts for tasks,
      parallel, cache, only what changed, sandbox and plugins, and a phone
      layout), the first bench alone, and four pillars (correctness,
      sandbox, extensibility, freedom). The ten Guide chapters, the labs
      and the widgets no page hosts went; every old chapter and Learn URL
      lands on its callout or the playground, now `playground/`, the Docs'
      last page. The Docs are six pages (quickstart, configure, sandboxing,
      CI and remote, migrate, plugins; 303-445 words of prose each), every
      old page redirecting to its section; every law that read a merged
      page moved with its text (20 one-line breakages each reddened one).
      `update-site.ts` stops writing the real-repo and scaling panels.

730.  DONE (2026-09-24, 729's leftovers). The playground no longer takes a
      lab: `<Playground lab>` and the element's `data-lab` read went with
      the labs page, and so did `Demo`'s `data` prop, which only that path
      used. The opening state is `START` in `playground/workspace.ts`;
      `labs.ts` keeps the three lab states and their steps, which core's
      parity rows still plan against the CLI. The site drops three
      devDependencies nothing in it imports (`@vzn/vx-lockfile`,
      `-migrate`, `-reapi`: `config-snippets` types every plugin import as
      `any`, and the choosing page only links their test files, granted by
      name). What it keeps is imported: `-github` by the CI summary row,
      `-schedule-history`, `-otel` and `-mcp` by the plugins guide's
      snippets.

731.  DONE (2026-09-24, 729's record). The 0.1.0 notes described the Learn
      section, which the short site removed, and would have announced pages
      that 404 to a redirect. Their site section now describes what ships:
      the landing's one diagram, the six Docs pages with "Try it", and the
      Reference. The roadmap marks the site's address as settled (1.5, and
      the timeline row) and Track W as superseded by item 729.

732.  DONE (2026-09-24, owner: "never do anything twice"). Once per run,
      first two slices. A strace of a 100-package run (200 tasks) found
      each task spawn looking `sh` up on the PATH again (2,800 stats cold),
      git looked up per spawn, two `rev-parse` spawns where one answers,
      `pnpm-workspace.yaml` read three times, each `vx.config.mjs` twice,
      and redundant cache-dir, run-lock and `.gitignore` calls. Now: `sh`,
      `git` and `strace` resolve once, on vx's OWN PATH (`util/which.ts`;
      a project's `node_modules/.bin/sh` had been parsing every command of
      that project, sandboxed ones included, `tests/task-shell.test.ts`);
      one `rev-parse` answers the enumeration and the hasher; a load's
      root files go through one `LoadReads` map per load (a watch cycle
      reads fresh); a project config is evaluated from the bytes the
      loader read, through a `Bun.plugin` onLoad, ESM and UTF-8 only
      (`project-loader.ts`). vx's own cold syscalls 6,274 → 3,456; cold
      `load configs` at 1,000 projects 256 → 181 ms (min of 7, loaded
      box); warm unchanged within noise. Held by
      `syscall-repeats.unsafe.test.ts`, `read-once.unsafe.test.ts`,
      `load-reads.test.ts` and `git-spawns-once.test.ts`. The output side
      (the third slice) is in flight.

733.  DONE (2026-09-24, upstream survey, nx#36415 class). A root
      devDependency bump moved no project's lockfile key: `taskBinDirs`
      puts the root `.bin` on every task's PATH and Node resolution walks
      up to the root `node_modules`, but a project's key folded only its
      own importer. With `pnpm()`, `bun()`, `npm()` or `yarn()` berry, a
      tool bump replayed the old tool's output as up to date, in this repo
      too (an `oxlint` bump selected 0 of 10 projects). `digestFor`
      (`orchestrator/lockfile-claim.ts`, the one shared implementation)
      now folds the root importer into every project's digest. Of this
      repo's 714 package bumps, the holes that selected nothing go 48 → 0
      and 624 still select exactly one project. Self-healing, no
      `CACHE_VERSION` bump.

734.  DONE (2026-09-24, upstream survey: turborepo#6744, #4214/#8989,
      #12640). The package graph linked a dependency by its KEY alone, so
      `"luigi": "workspace:../waluigi"` planned `luigi#build`, a `^1.0.0`
      range against a local 2.0.0 planned the local build, and a registry
      dev dependency shadowing a workspace peer still added an edge. An
      entry is now an edge by its spec (`buildPackageGraph`, rule and
      measurements in `docs/modules/package-graph.md` § "Which entries are
      edges"): `workspace:` by name, range, alias or path; `file:`,
      `link:`, `portal:` and bare paths by directory; `npm:` aliases and
      plain ranges only when the local version satisfies them, through an
      exported `SEMVER_RANGE` grammar, because `Bun.semver.satisfies`
      answers true for `latest`, `../x` and other non-ranges. Every
      spec form was measured against bun, npm, yarn and pnpm installs.
      pnpm's `link-workspace-packages` is documented, not honoured: the
      graph is built before any lockfile plugin runs (a lockfile → graph
      seam is open). The playground bundles a `semver` shim held to
      `Bun.semver` over the grammar; `nx()`'s implicit-dependency report
      asks the graph instead of the manifest. Graph build at 1,000 × 30
      deps 7.0 → 8.7 ms.

735.  DONE (2026-09-24, owner: "find out why Nx is so slow"). Two things,
      both per task (`benchmarks.md` § Why Nx is slower). Nx's
      `nx:run-script` forks a Node process per task that loads Nx
      (~270 ms of CPU each). On four cores that saturates the CPU and
      stretches the critical path: 21.4 s cold at 46 packages against
      11.7 s with `nx:run-commands`, which runs in-process. And the
      harness gave Nx npm: the workspace has no lockfile, so Nx fell back
      to `npm run` (202 ms of CPU a task) while Turbo ran `bun run` (4 ms).
      That was 28.8 → 21.4 s at 46 packages and 20m 39s → 7m 22s at 1,090.
      `compare.ts` now sets `cli.packageManager: 'bun'` in `nx.json`. The
      harness keeps `CI=1`, so Nx's daemon stays off (owner: "we simulate
      ci env"); the docs that said "daemon on" were wrong. Refuted: the
      PTY, the TUI or output style, the daemon (22.25 s on, 22.08 s off),
      and capped parallelism. CLAUDE.md principle 3 gains the line that
      nothing boots between the scheduler and the shell.

736.  DONE (2026-09-24, upstream survey, nx#28477, #31345, #12165,
      #23581, #20465, #32610, #33092). `nx()` now runs `nx:run-commands`
      targets as Nx runs them: `commands` in parallel unless `parallel:
false`, the first failure failing the task; `commands: []` a no-op;
      args after `--` and unconsumed options forwarded per Nx's
      `forwardAllArgs` / `args` / `{args.*}` rules (`nx-exec` hands flags it
      does not own to Nx's `createOverrides`); `env` into
      `exec.env.define` (so the key sees it); `envFile` and Nx's automatic
      `.env` files loaded at RUN time by Nx's own loader (a new `nx-env`
      bin), their bytes in the key through a runtime input, never written
      into `vx show` or the lock; persistence from Nx's `continuous`
      field, never the target's name (a cached `dev` target caches). Both
      `nxCache()` and `turboCache()` ask for `application/octet-stream`, so
      a gateway that base64-encodes other types no longer turns every hit
      into a corrupt artifact. Parity rows compare each option shape with
      real Nx 22.7.12. Still todos (reported in the migration): `{args.name}`
      from `--`, several `readyWhen` strings, per-command prefixes. The
      live rows ran red in CI's sandbox: the parallel line exited before
      a TERMed command's trap ended, where Nx settles every command
      first, so the line now waits for them (each job's shell catches
      the TERM); and `nx run` inside the sandbox could not listen on its
      plugin workers' sockets, so that row sets `NX_ISOLATE_PLUGINS=false`,
      what Nx does itself when it sees a sandbox.

737.  DONE (2026-09-24, upstream survey, nx#32779, nx#28788, nx#35292).
      A `^name` that NO project in the workspace declares (`^biuld`) is
      refused like a misspelled same-project name; it planned no edges and
      exited 0. A scoped run checks the configs it left out only then, and
      `turbo()` / `nx()` drop a `^name` no mapped project emits, as Turbo
      and Nx give it no edges. The graph builder expands on an explicit
      stack: a 50,000-deep chain plans and a ring is refused with the same
      message, where both threw `RangeError`; 60,000 random workspaces
      matched the recursive builder node for node. `FORCE_COLOR=0` and
      `=false` turn vx's colour off (they turned it on); tasks still get the
      variable unchanged. Open from the survey: a graph-build error leaves
      the local cache open (`prepareRun` closes it only on config and
      cache-plugin errors).

738.  REFUTED (2026-09-24, the owner's "never do anything twice", output
      side). A run-scoped path memo (facts about output paths shared by the
      check, walk, clean, pack, extraction and snapshot) was built and
      reviewed adversarially twice. Review one reproduced two containment
      escapes (a restore writing through a symlink a concurrent or
      unsandboxed task planted; main refuses both); review two, after those
      closed, reproduced a stale file mode packed through a cross-project
      hardlink and a directory left out of the run-end snapshot. With all
      four closed the restore made 11% fewer syscalls (46% fewer
      `getdents64`) and was within noise of main on wall and CPU, min and
      median, two sessions. Not shipped. The lesson is principle 9's
      limit: an unsandboxed task may write anywhere, so a fact about a file
      a task could write is not reused across task runs, and a refusal is
      never decided from a memo.

739.  DONE (2026-09-24, upstream survey: three silent stale hits).
      An UNSET declared `cache.inputs.env` name keyed like one set to `""`
      (turborepo class `stale-hit:env-unset`): it now folds as the bare
      name, a NUL in an env name is refused so the two can never meet, and
      keys for SET values are byte-identical (the key-fold pin held); the
      REAPI plugin leaves an unset name out of the remote Command. A file
      whose name is not UTF-8 was decoded lossily from git's `-z` output and
      from `Bun.Glob`, so an input by that name was never read and an output
      never saved (turborepo#9345): such a name is now refused by name.
      The line-ending check missed git's default global and system
      attributes files: one `git var -l` (git ≥ 2.42) now names them, same
      spawn count. `CACHE_VERSION` v31 → v32: an artifact saved before the
      non-UTF-8 fix lacks that output under an unchanged key. The fourth
      fix of the batch, `--exclude-dependencies` keying on the dependency it
      skips (nx#35234), conflicted with item 737's graph builder and is
      item 741.
740.  DONE (2026-09-24, upstream survey: process lifecycle). Eight
      Turbo and Nx signal and teardown bugs reproduced on vx and fixed.
      `vx watch` keeps a requested dev server up until the next cycle
      starts (turborepo#9421). Both teardowns SIGKILL every task group
      with a member left at the grace, not only the shell
      (nx#8286), and so does an `exec.timeout` (nx#11782). A persistent
      task gets a stdin pipe vx holds, so a server that exits on EOF
      stays up (turborepo#8915). The signal vx received is the one
      forwarded, SIGINT for Ctrl-C (turborepo#444, nx#23585). A run lock
      naming our own pid, or on Linux a recycled one, is stale
      (nx#36473). The post-exit drain bound says when it cut output
      (nx#35302). `kill -9` of vx leaving persistent tasks is a
      documented limit: `PR_SET_PDEATHSIG` needs a pre-exec hook Bun
      lacks, and an ffi wrapper cost 9.8 ms per spawn (turborepo#9666).
      The gate caught what the batch's unsandboxed shard runs missed:
      under vx's sandbox `/proc` is another pid namespace's (the task is
      pid 2, `/proc/self` names 7), so the group check found no member
      and a SIGTERM-ignoring server hung the run. `util/procfs.ts` asks
      once whether `/proc/self` is our pid; if not, the group signal and
      the plain pid are the answers.

741.  DONE (2026-09-24, upstream survey, nx#35234). `--exclude-dependencies`
      dropped the skipped edge from the KEY as well as the schedule, so
      `app#build` keyed on nothing of `lib`: a miss for no reason, then,
      once `lib` changed and was rebuilt, a hit that replayed the old `lib`.
      The graph is now built whole (the `graph` and `key` stages see it as
      a full run does); `excludeDependencies` narrows the schedule, and
      `orchestrator/excluded-keys.ts` keys each dropped task without
      running it, folded at the run, the plan and the up-front classify, so
      a key is the same with and without the flag. A task whose key folds a
      skipped key, and all built on it, may hit but does not save (its
      dependency's outputs may predate its inputs), and the run says so on
      one line. Ported onto item 737's builder: a typo'd `^name` is now
      refused under the flag too, where 737 let a name the flag dropped go
      unjudged (validity, like a key, does not depend on the selection);
      the dropped-key walk and the taint count are iterative, since the
      original recursed once per edge (`RangeError` on a 50,000-deep
      chain) and its taint fixpoint took 100 s on one. Self-healing, no
      `CACHE_VERSION` bump. Open: an executor that keeps its own record of
      executions under the cache key (`@vzn/vx-reapi`) is not told a task
      is tainted, for this taint or `--continue=always`'s.

742.  DONE (2026-09-24, upstream survey: cache robustness). Two processes
      opening one NEW cache both read no `schema_meta` version row and the
      second insert died on the primary key (nx#28608, 2 in 100 paired
      runs): the write half now re-reads under `BEGIN IMMEDIATE`, and a
      warm open takes no lock. An artifact removed between a hit's probe
      and its restore (a `vx cache prune` in another shell, nx#36688; the
      retention of another workspace sharing `--cache-dir`, nx#34032)
      failed the task as an internal error: it is now a miss
      (`ArtifactVanishedError`) and the task runs. A restore-tier hit may
      be running ahead of its deps, so it throws `RestoreDemoted` and the
      scheduler runs it once they are done — run in the restore's slot,
      it would build from their unwritten outputs and save that under the
      healthy key (`tests/vanished-artifact.test.ts`, at one and four
      workers). Warm-path cost: the hit path gains one awaited wrapper and
      one `.catch` per task, 60–70 µs per 1,000 in isolation; the
      1,000-project warm no-op and restore A/B (interleaved, before arm
      from a worktree) sat inside the box's noise (no-op min 221 → 237,
      then 301 → 300 ms; restore min 574 → 549, 871 → 743). A deleting
      `vx cache prune` also takes the workspace's run lock now, so beside
      a run on the same workspace it waits instead of making that run
      re-run its hits (a dry run takes none). `cacheRetention` summed
      index rows only, so row-less artifacts (a schema reset, a deleted
      `cache.db`, a crashed save) neither counted nor went: 9 MiB sat
      under a 1 MB limit (nx#35483). The orphan sweep now also runs on
      its own clock (`schema_meta.orphans_swept_at`, at most hourly):
      listing the directory costs 0.5 ms per 1,000 entries (4.9 at
      10,000), the clock read 4 µs. A declared output directory made a
      link out of the project after its entry was saved failed every run
      as "internal error … ArchiveSecurityError" (nx#37061's shape): it
      is now a user error naming the link and its target, and the link
      is kept — never written through (containment unchanged) and never
      replaced, which is the bug nx#37061 reports. Documented, no code: a
      task's outputs are what exists when its command exits; a descendant
      it detached (`setsid … &`) that writes later is saved as nothing
      and wiped by the next hit's restore (turborepo#12786;
      caching.md § Cache write, execution.md). A workspace member glob
      `packages/!(x)` listed x too (turborepo#3766): `Bun.Glob` has no
      extglob and its scan read the group as a wildcard. Supporting a
      subset in vx would be a second glob grammar, so every extglob form
      is refused by name, with the exact `!` rewrite for a whole-segment
      `!(a|b)` (npm, yarn and pnpm all take `!` entries).

743.  DONE (2026-09-24, upstream survey, turborepo#13788). A task with no
      `cache` block declares no outputs, yet writes: an uncached `gen`
      copying a seed into a same-project `build`'s declared `config.json`
      replayed seed B's build under seed A on the fourth run of A,B,B,A,
      silently. Two facts were stale. The stability gate classed `build`
      stable, so the short-circuit keyed it before `gen` ran; an uncached
      producer now counts where `undeclaredWriteReach` says it may write
      (its project; a sandbox narrows that to its write grants, none to
      nothing). And the run-start git listing, index OIDs and
      `package.json` digest outlived `gen`'s writes, so a tracked
      `config.json` keyed its committed OID even on the lazy path: they are
      dropped once an uncached command exits, pass or fail, and once a
      persistent task is ready. Rule: an unsandboxed write into ANOTHER
      project is out of contract, as for a cached task. This repo's
      `check.bun` is sandboxed with no write grant, so the gate's shards
      stay in the restore tier. Then turborepo#10111 and #1146: a key is
      taken before the command, so a formatter rewriting its own input, or
      a user's edit mid-run, filed bytes built from one state under the key
      of another, and restoring the old state replayed them as up-to-date.
      A miss now re-checks before it saves: the key re-derived just before
      the command must match, and one `lstat` per input (and the
      `package.json`) finds any file changed since its digest was learned
      (the enumeration's start for an index OID, the describe for a hashed
      file), which is hashed again. A move withholds the save with one
      status line and drops the project's facts. A hit checks nothing
      (warm A/B within noise); a miss pays ~1.8 µs per input file on the
      main thread (`miss: recheck inputs`: 16 ms per 1,000 misses of two
      inputs, 55 ms per 100 misses of 302; cold wall min-of-11 on a loaded
      4-core box 624 → 667 ms at 30,200 inputs). Not seen: an input
      changed and changed back before the check, a file added under a
      glob. `CACHE_VERSION` v32 → v33: an entry the old code poisoned sits
      under the key the fixed code derives when the tree is back in that
      state (probed: the fixed code under v32 replayed a formatter's
      poisoned entry as up-to-date), so it is not self-healing.

744.  DONE (2026-09-24, Next 17: why Turbo won warm at size). Not the
      cache: `deriveStableKeys` built each task's transitive set of
      upstream output producers by copying every dep's string `Set`,
      tasks × deps × projects inserts — 101 ms of CPU self time in a
      513 ms warm profile at 476 packages, growing with the graph. The
      set is now a bitset over project indexes (`ProjectSet` in
      `stable-keys.ts`), so a union is a word-wise OR; the gate reads
      it unchanged. Warm, compiled, interleaved against a `git worktree`
      "before" (main after item 742): 476 packages 0.45 → 0.35 s (Turbo
      0.35, min of 9); 3,270 tasks 0.89 → 0.56 s (Turbo 0.71, min of 7). The existing
      rows hold the union, the direct add, the iteration and the size
      (each neutralised in turn, each red).

745.  DONE (2026-09-24, upstream survey: the missing rows and the
      ledger). The survey mapped 302 Turborepo and Nx bug reports; 66
      had no test that would notice vx regressing into them (one was
      pinned by item 734 since). 63 are written, each through the real
      path (a run, the CLI, a pty, a real shallow clone or worktree),
      and rows in every file but three were shown red under a mutation
      of the code they guard: not task-selection or watch-loop, and a
      named pipe in inputs is kept out by git's and `Bun.Glob`'s own
      enumeration, which no vx line decides. Writing
      them found two faults: a Yarn 4 `catalog:` dependency is recorded
      as the literal `"catalog:"` in `yarn.lock`, so under `yarn()` a
      catalog bump moves no workspace digest (a stale hit, open); and a
      remote upload that times out, or a server that cannot be reached,
      warns with the bare runtime message, naming neither the request
      nor the server, once per request. One row stays untested: an
      output past the 2 GiB ceiling costs 6 to 14 s a run. The page
      `docs/upstream-ledger.md` lists every report with its verdict and
      the test that holds it, and `tests/upstream-ledger.unsafe.test.ts`
      fails when a cited title is not a test in the file it names (two
      template-titled loops were unrolled so their rows can be cited).

746.  DONE (2026-09-24, Next 20 and 21 as they stood: the graph at
      scale). `vx run app#t0 --dry` on a 50,000-deep chain threw
      `RangeError` from `pinnedLocalSet`, a walk items 737 and 741 left
      recursive. Grepping the class found four more recursions over the
      task graph, each reproduced at 50,000 and each now on an explicit
      stack: the restore-tier exclusion below a workspace-output writer
      (a real run of a 50,000-deep group chain over one threw out of the
      classify); `expandGroupUpstream` (a task over a 50,000-deep chain
      of groups failed as an internal error, and a group reached along
      two paths was expanded once per path, 2^16 reads for sixteen
      stacked diamonds, now once); `keyedProjects` (a sandboxed task's
      fold); and `materializeFor` (a deferred producer's closure). The
      pin and the exclusion flow up the dependant edges from what seeds
      them, and a graph that pins nothing builds no index. Each fix has
      a row at 50,000 that throws `RangeError` without it, and a
      50,000-task cached chain then ran green cold (443 s) and warm (6.2
      s). The package graph's walks, the cycle check, the lockfile's
      Tarjan walk and the plan's critical path were already iterative (a
      50,000-project chain filters in 29 ms). Not recursion, and left:
      the scheduler's reverse-dependant closure and the package graph's
      transitive closure are bitsets of n²/32 words, 312 MB at 50,000
      tasks by arithmetic, and `transitiveDeps` on a 50,000-project
      chain took 3.4 s. Then `detectOutputCollisions` compared every
      pair of a project's tasks with outputs: 10.0 s for 4,000 distinct
      literals in one project, 2.65 s for globs. A path index now names
      the pairs that can overlap (equal globs, equal literals through
      their `/**` twins, and a literal against the globs whose literal
      head names one of its ancestors, the head ending at `*?{}`, `\` or
      a leading `!`), and `collide` runs over them in all-pairs order,
      so the refusal and the addition marks are all-pairs' own. A fuzz
      of nearly four million glob/literal pairs found no match outside
      the head, and thousands once `\` and `!` were dropped; a
      differential over 3,000 random configs holds the index to the
      all-pairs loop, and nine mutations of the index are each caught
      (the `!` one only once the configs were drawn with mulberry32:
      drawn from an LCG's low bits by `% n`, they never held a pair that
      decided it). Two lookups that survived mutation were redundant and
      went: equal literals, and a glob filed at a literal's own path
      (the fuzz found no glob matching the directory its head names).
      Interleaved, first build, min of 3: 4,000 literals 10,040 → 9.8
      ms, globs 2,650 → 7.6, mixed with a chain 8,576 → 15; 1,000
      projects of ten literals 54.8 → 8.0 ms; 1,000 workspace-output
      declarers 142 → 0.85. The warm 1,000-project bench ties, n=25 and
      31: `build graph` min/median 1.8/2.2 ms before and 1.7/2.2 after
      (A/A 1.8/2.1), the run 194/219 ms before and 197/233 after against
      an A/A of 195/224. A call per single-task project had cost that
      stage 0.4 ms until the call site skipped it. The time bound at
      4,000 fails the old loop tenfold.

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
    is the record since 719 (14dj in the next-log file); 14dk is below,
    and the next entry written here is 14dl.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dk. **Handoff after item 727 (2026-09-24, midday).** Since 14dj the
site was redone as one story and read on a phone: the Guide of ten
chapters on one toy monorepo, Docs and Reference around it, internals
out of the sidebar, one look, build-time pictures (721); the old Learn
pages retired with redirects (722); the widgets restyled and cut (723);
every picture, the cover, the graph explorer (724) and the scheduler's
charts (725) given a phone form, held by the diagram kit's laws, and
code blocks wrapped. Core alongside: a sandboxed task no longer reads
its own package through its self-link (720, `CACHE_VERSION` v30), nor a
linked sibling its key does not cover (726, v31, the Decisions entry on
narrowing core's grant), and a task downstream of a persistent task has
one key on both paths (727). WHAT STANDS: 14dj is in the next-log file
(§ Handoff 14dj); the loop holds 719–729. OWNER, unchanged: the site's read
(Next 16), cut 0.1.0 (the tag, then delete `NPM_TOKEN`), the scope list (roadmap 2.4), the soak length. NEXT: the owner's read of the short site (Next 16); the trim when the loop reaches twenty items; the warm-path A/B on the next run-path change (Next 6). Never end with "what
next?".

16. **The site, short (owner, 2026-09-24, after 728).** Shipped as item
    729 (`design/site-short-2026-09.md`). Left: the owner's read.
17. DONE as item 744 — **Turbo 2.11 won warm at 476 packages on the Linux box (item 735).**
    Two one-rep runs read Turbo at 255 and 303 ms against vx's 334 and
    376 (restore: 436 and 446 against 524 and 478). Measure it min-of-N
    with interleaved arms, find where vx's warm path spends it at that
    size, and fix it or say so on the site. The 3,270-task run on the
    same box reads the same way: Turbo 496 ms warm against vx's 678.
18. **Re-run the site's benchmark with the fixed harness (item 735).**
    The landing's Nx numbers (34m 44s cold, 3,270 tasks, macOS) come
    from the harness that gave Nx npm; npm was two thirds of Nx's cold
    run at that size on the Linux box. OWNER: re-run `compare.ts 100 11
1` on the macOS machine and `update-site.ts`, or take the Linux run
    in `benchmarks.md` (where Turbo wins warm, Next 17) for the site.
19. **A sandboxed task's `kill 0` kills the sandbox (Linux, found in
    736).** bwrap's `--new-session` puts the runtime's wrapper shell in
    the task's process group, so a command that signals its own group
    ends the wrapper too. This line succeeds unsandboxed and fails 143
    sandboxed, the pid namespace's teardown SIGKILLing the rest mid-trap:
    `sleep 10 & trap 'trap "" TERM; kill 0' EXIT; echo done`. Put the user command
    in a group of its own inside the sandbox without losing the TERM
    grace a cancellation gives it, and pin both.

20. **Yarn 4 catalogs make `yarn()` keys stale (found in 745,
    turborepo#12635).** A real Yarn 4.18.1 install records a catalog
    dependency as `"catalog:"`, and `resolveDescriptor` folds that
    literal: bumping the catalog `^6 → ^7` left every importer digest
    byte-identical, a stale hit under `yarn()` and a miss for
    `--affected`. Resolve the catalog entry through `.yarnrc.yml` (or
    the lockfile's resolution), with the ledger's row as the pin.
21. **A remote-cache warning names nothing (found in 745).** An upload
    timeout warns `vx/<plugin>: The operation timed out.` with no PUT,
    hash or server; an unreachable server repeats the bare runtime
    message once per request (3 lines for `turboCache`, 2 for
    `nxCache` on a one-task run; a 401 is already deduplicated). Name
    the operation and endpoint, and say it once per run.
22. **A dangling output-root link fails a hit (found in 745, confirmed
    on main after 742).** `dist -> real-out` inside the project with
    `real-out` deleted: the next hit exits 1, "blocked by what is on
    disk (EEXIST mkdir …/dist) … a path the output globs do not
    cover", which is wrong, since `dist/**` covers it. Restore through
    an in-project dangling link (make its target) or replace it, and
    say which.
23. **Three stale-hit edges 743 left (its report).** A cached task that
    rewrites its own input in place (a formatter with `outputs: []`)
    leaves a same-project `tasks: []` reader classed stable, so it can
    be restored ahead of the formatter for one run; cached tasks that
    run but do not save (read-only policy, tainted upstream) do not
    mark their outputs changed in the git snapshot; the workspace
    fingerprint and `inputs.runtime` values are memoised per run and
    not re-checked before a save.

## Decisions (this arc)

- **Once per run (owner, 2026-09-24, item 732).** Within a run nothing
  outside vx changes the files it reads; what vx learns once (a read, a
  stat, a PATH lookup, a spawn's answer) it reuses, and only vx's own
  writes or its tasks' runs invalidate a fact. A repeat that stays has a
  measured reason in a comment and in the strace laws that pin it.
- **Tools resolve on vx's own PATH (item 732).** The task's PATH decides
  what its command runs, never which shell parses it.
- **Every project's lockfile key folds the root importer (item 733).**
  What the root declares is reachable from every task.

- **Declaring `cache` may narrow core's own grant, never widen one
  (owner-delegated, 2026-09-24, item 726).** The user's `sandbox.allow`
  still derives nothing from `cache` (2026-09-05). Core's implicit
  `node_modules` link grant is bounded by the key for a task that
  declares `cache`: a linked workspace package is granted only when the
  key folds a task of it, because an unkeyed read is exactly the stale
  hit the sandbox exists to rule out. A task with no `cache` keeps the
  whole grant, having no key to be stale. The coverage is per package,
  not per file (an edge to `ui#source` also admits `ui/README.md`), the
  same limit a grant wider than a task's own inputs already has.

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
