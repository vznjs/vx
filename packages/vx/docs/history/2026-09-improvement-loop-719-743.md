# Shipped, 2026-09 — improvement-loop items 719–743

The record `docs/STATUS.md` carried until 2026-09-25, moved here whole
when the loop passed forty items (item 764). A PREFIX,
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
`2026-09-improvement-loop-553-572.md`, items 573–591 in
`2026-09-improvement-loop-573-591.md`, items 592–611 in
`2026-09-improvement-loop-592-611.md`, items 612–631 in
`2026-09-improvement-loop-612-631.md`, items 632–654 in
`2026-09-improvement-loop-632-654.md` (655–713 are handoff entries in
`2026-09-status-next-log.md`; the audit's 714–718 were dropped, as that
file records); items 744 onward continue in
`docs/STATUS.md`.

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
