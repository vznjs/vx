# 0.1.0 — draft release notes (2026-09-22, refreshed 2026-09-24 through item 710)

**Status: a draft for the owner to cut the release from (launch checklist
item 2; plan D4).** 455 pull requests merged since v0.0.21 (2026-09-15,
counted at item 713 through #798 as the first-parent commits of
`git log v0.0.21..origin/main`; recount when the tag is cut),
every one a titled squash, so GitHub's generated notes are accurate; this
page is the same record grouped by what a user meets, with the internal
work in one line at the end. Version: `0.1.0` says "first real release"
where 0.0.22 says "another nightly".

## Nx and Turbo repos, unchanged

- `nx()` runs an Nx repo with nothing written: every target the resolved
  project graph defines becomes a task, executor targets run through
  `nx-exec` (one executor, one process, Nx's own `runExecutor`) and
  run-commands targets as the shell they are; configurations are
  `<target>:<configuration>` tasks; `cache: true` and the legacy list decide
  caching; a root-relative output outside the project restores as a
  workspace file. The graph is a snapshot under vx's cache dir, refreshed
  by `nx graph --file` when `nx.json` or a `project.json` is newer.
  Proven on refine (Nx 18, 205 of 205 targets identical) and on real Nx 22
  with `@nx/js:tsc`; `nx-exec` starts in 214 ms against `nx run`'s 346
  with the daemon warm.
- `turbo()` runs a Turbo repo the same way; both share one adoption
  skeleton, and `bunx @vzn/vx-migrate --from nx|turbo` writes the configs
  when you want the files. The migration was walked on astro and on Nx
  22 through to a build and a restore.

## Selecting and running

- `--filter ./packages/[abc]` selects the directory it names: a path that
  names a project directory is read literally before it is read as a glob.
  A range base (`--affected=HEAD~1..HEAD`) is refused by name.
- `--affected` selects the changed projects **and their dependents**, the
  superset a CI gate needs; `--filter '[<base>]'` is the changed-only form.
  A base that is HEAD itself, and a shallow clone, are named for what they
  are.
- One run at a time per workspace on this machine; the lock's release is
  awaited, so a CLI run leaves no lock directory behind.
- A task dies with everything it forked: process groups, `SIGHUP` on
  teardown, and a skipped task's row names the blocker that skipped it.
- A task says why when its shell or its temp directory refuses it; a `git`
  that is not on PATH is one refusal, never a stack; a typo'd verb is one
  line with a help pointer, and an unknown verb is answered with the verbs
  this workspace declares.
- `vx watch`: a git-ignored path never starts a cycle, and a task that
  rewrites its own inputs is named. A cycle that re-reads the configs
  starts one config worker for the round, not one per config (50 configs:
  148 ms → 10.5).
- Every package's code floor matches the `engines` it declares (Bun ≥
  1.4); `vx info` reports it, and `vx` warns once below it.

## Caching

- **A stale-hit fix, with `CACHE_VERSION` v30:** a sandboxed task no
  longer reads its own project through a `node_modules` link. npm and
  Yarn link every workspace package at the root, the task's own included,
  and the sandbox granted that link whole, so an undeclared read of the
  task's own file ran unreported and an edit to it was a cache hit. The
  next miss now fails on that read; the bump drops the entries saved
  before the fix.
- **Breaking, and a stale-hit fix:** a bracket is a literal character in
  every task glob (`cache.inputs.files`, `cache.outputs.files`,
  `workspaceFiles`), so a route directory like Next.js's `app/[id]/` is
  what its pattern names. Read as a character class, an input over one
  keyed nothing and replayed an old output on an edit, and an output
  under one deleted its namesake (`app/i/page.js`) while saving nothing.
  `\[id\]` still works. `CACHE_VERSION` moves to v28, and the first run
  after the upgrade says `cache format changed` (every bump will).
- **A stale-hit fix that moves every key:** Bun's xxHash3 reads only 32
  bits of a seed, so the seed-chained key fold carried 32 bits of state
  and two input sets could share a key (a birthday search found one in
  under a second). The fold feeds the seed forward; the lockfile plugins
  fold the global digest as data. `CACHE_VERSION` moves to v29: every
  entry misses once, with the notice.
- **Breaking, and a config-evaluation fix:** a config is JSON data, on
  every path. A value JSON cannot carry (a function, a symbol, a bigint,
  `NaN` or `±Infinity`, `undefined` inside an array, a cycle, a `Map`, a
  `Date`, any object neither plain nor an array) is refused before the
  schema, with one message that names its path
  (`tasks.build.description is a function`) and says a config must be
  JSON data because the cache key folds its JSON. Before, `vx watch`
  accepted a function-valued field that `vx run` refused, and a `Map` as
  `tasks`, a `Date` as `exec.persistent` or a hole in `dependsOn` loaded
  on both paths and was keyed as `{}`, a string or `null`. A plugin's
  `project` edit and a `vx-lock.json` entry meet the same rule; an
  `undefined` property is still allowed, and `vx.workspace.ts` (whose
  plugins are functions) is not held to it. No key moves;
  `CONFIG_EVAL_VERSION` 3 re-evaluates each cached config once.
- **Breaking:** a negated absolute path in `cache.inputs.files` (`!/x`)
  is refused, as `workspaceFiles` already refused it: it subtracted
  nothing from the project-relative globs and sat in a config as a silent
  no-op. A config that carries one now fails to load.
- `cacheRetention: { olderThan, maxSize }` in `vx.workspace.ts` evicts at
  the end of a run, by the policy `vx cache prune` takes as flags, and
  only when something is due.
- A restore writes a 242–255-byte file name (the staging suffix pushed it
  past NAME_MAX); a component past NAME_MAX, a name past PATH_MAX and a
  destination too deep for a name are each refused by name.
- A remote-cache URL carrying `user:pass@` is refused (`turboCache()`,
  `nxCache()`); the URL is printed in their error lines.

- A negation pattern subtracts from the root walk too; a literal output is
  read as the tree it deletes; glob prefixes compare as paths, not
  spellings; an output collision spelled with `?`, a character class or a
  brace is refused like one spelled with `*`.
- A gitignored file **or directory** named as a literal input is refused
  rather than silently folding nothing (the stale hit the refusal exists
  to stop).
- A failed git command is an error, not an empty answer; a tree that is
  not a git checkout is refused on the fallback enumeration; git
  attributes are read where git keeps them.
- `.git` and `.vx` are never touched by an output wipe; an emptied parent
  directory is pruned after a clean, so a later restore's rename is never
  blocked by it.
- A project inside a nested repository is enumerated by its own git, and
  every project under a changed nested repository is `--affected`.
- A cache directory this user cannot write opens read-only for the readers
  and fails a run before any task; a full disk, a staged file another run
  removed, an output vx cannot remove — each is one line naming the path,
  never a stack or a "corrupt artifact".
- A remote cache layer's wrong shape is named as such; a refused remote
  token is reported once, not once per in-flight call; an artifact with no
  stdout is refused without leaving one behind; a NUL-bearing or empty
  archive name is refused through the pax door too.
- An upstream with no cache key is pinned and explained (`vx why` says why
  its consumer's key moved after the upstream's first run).

- A cold run's config round is written once per table, not once per
  config: `load configs` at 1,000 projects 507–607 ms → 207–272; the
  output-directory snapshots land in one transaction at run end (the stage
  52–70 ms → 10–17 cold, 64–75 → 12–14 on a restore).
- A restore stopped probing, re-creating and realpathing what it had just
  made, and a save stopped re-creating the cache directory twice per
  artifact; both paths were traced by counting vx's own syscalls, a
  method now in the bench package (`strace-vx.ts`).

## Sandbox (Linux `bwrap`, macOS seatbelt)

- The post-run sweep no longer deletes what the task itself wrote; a
  write grant that mounts nothing is reported with what to write instead;
  a write grant that meant a directory is spelled `dir/`.
- A sandboxed task is pinned to this machine (its profile describes this
  host); each sandboxed task gets its own strace trace; a dead process's
  mux socket under a recycled pid is removed before the runtime listens.
- The sandbox names its three Linux dependencies (`bubblewrap`, `socat`,
  `ripgrep`) when one is missing, and `vx info` reports the runtime's
  verdict and the tasks that need it.
- A task that produced nothing under the sandbox has its cause named.
- A traced path that starts with `~` is read against the task's working
  directory, as the kernel reads it, not against HOME: an undeclared read
  under a project directory named `~cache` was dropped from the report.

## Failures and what they say

- A failure is labelled once, with its signal, on every surface: the
  frame, the GitHub summary's callout, `vx last`'s replay of exit code and
  signal, the runs table. An exit above 128 names its signal; 127 and 126
  name the shell's verdict; a timeout is labelled as its reason; sandbox
  violations are counted in the label and every record.
- `vx last` folds hits past sixteen rows and names each skipped task under
  the failure that blocked it; a persistent task that never became ready
  is labelled by its reason.
- File-system refusals (`EACCES`, `ENOSPC`, a lockfile that cannot be
  read) print one line naming the path and the side.
- A run with failures ends with a `Failed:` block: each failed task's
  label and its last 30 lines (stdout then stderr, as its frame prints
  them), at most 8 KiB, with a note of what was cut; five tasks get a
  tail and the rest are named. In a long CI log the frame is thousands of
  lines up, and GitHub's API returns only a job log's last 5,000 lines.
  It prints in every view that prints task output (not `none` or
  `hash-only`), fenced from workflow commands on GitHub Actions; exit
  codes, telemetry and the cache are unchanged, and a custom logger gets
  none.

## Plugins and packages

- **Breaking for remote-cache plugin authors:** `RemoteCacheLayer.get`
  resolves `{ body: Blob | Response }` and `put` takes a `Blob`, so an
  artifact streams between disk and the wire instead of sitting in
  memory (a 150 MiB round trip: +495 MiB peak RSS before, +45 after). A
  layer that still resolves bytes is refused as invalid, naming the new
  shape. Every first-party layer moved with it.
- **The seven plugin packages are on npm for the first time**, published
  with every release at the core's version and peer-pinned to it:
  `@vzn/vx-migrate`, `@vzn/vx-lockfile`, `@vzn/vx-reapi`, `@vzn/vx-otel`,
  `@vzn/vx-github`, `@vzn/vx-mcp` and `@vzn/vx-schedule-history`. Until
  now `bunx @vzn/vx-migrate` named a package the registry did not have.
- `@vzn/vx-migrate`: Nx's runtime input maps to `cache.inputs.runtime`,
  `project:target` to `project#target`, a package `turbo.json` merges over
  the root task, `extends` is in the table; the generated `vx-preset.ts`
  names the tool as the configs do; the overlap rule is core's, not a copy.
- `@vzn/vx-otel`: `timeoutMs` is wired; a collector that refuses or drops
  the export is reported.
- `@vzn/vx-github`: the job summary is bounded by GitHub's 1 MiB cap and
  the CI guide shows it.
- `@vzn/vx-mcp`: `whyDidThisRerun` defaults to the latest run;
  `getRunHistory` names the usage its rows carry.
- `@vzn/vx-reapi`: the plugin refuses a Bun below its floor at its wire;
  `--force` reaches a remote executor.
- A telemetry sink that swallows a failure still owes a warning; the
  plugin boundary's sentences are pinned.
- `VxPlugin.setup`'s contract says when it runs: after the config,
  project, cache, graph, key and schedule stages, before the executors,
  the telemetry sinks, admission and the first task, and never on a plan
  (`--dry`, `planRun`). It had claimed to run before any capability is
  consulted; the site's four copies are corrected and a row holds the
  order.
- `@vzn/vx-reapi` names `VX_REAPI_EXECUTE=1` beside its endpoint and
  instance; each plugin's index carries what a workspace calls, its
  internals live in files; the MCP README's tool table is held to the
  server's list.

## CLI and upgrade

- `vx upgrade` verifies the release digest, refuses a binary npm owns, and
  names the host it could not reach; the README's install row says what
  exists.
- `vx lock` names the projects it cannot freeze; `vx info` names a broken
  config once and counts its sandboxed neighbours' declarations; `vx cache
stats` points at the verb that answers it.
- Piped stdout is flushed before the CLI exits, and a reader that leaves
  (`| head`) does not fail the run.
- The CLI reference lists every environment variable vx reads, with its
  default and the fallback rule each timeout keeps; `vx watch` says when
  it polls and `VX_WATCH_POLL=1` polls from the start; the picker names a
  wrong answer, and `vx run` in CI says why it asked for nothing.
- `vx why`'s key diff lists in code-unit order (uppercase first, SQLite's
  own order), not the machine's locale, so its order no longer moves with
  `LANG` and the playground's diff lists the same way.

## The site teaches

- A Learn section opens the sidebar and teaches task orchestration before
  it sells vx: each teaching page explains the idea in tool-neutral
  terms, then how vx does it, then one sentence each for Turborepo, Nx
  and Bazel checked against their own docs, then a checkpoint. Every widget renders a
  no-JavaScript version that teaches on its own.
  - `learn/what-is-task-orchestration`: tasks, dependencies, the task
    graph and why `npm run` stops scaling, with a graph explorer over a
    four-package toy monorepo.
  - `learn/caching`: content addressing, what a key folds, why it folds
    upstream input keys and not outputs, and a key calculator whose model
    is held to real `vx run`s (moved keys, hits, stale bytes).
  - `learn/correctness`: the stale hit, declared against inferred inputs,
    and the sandbox as the proof, with a stale-hit demo held to vx and to
    a live sandboxed run.
  - `learn/scheduling`: workers, the critical path, why the order of ready
    tasks matters, with a simulator that ranks by vx's own scheduling
    code in the browser.
  - `learn/architecture` and `learn/extending`: the pipeline with seams,
    with an explorer over the thirteen hooks read from `VxPlugin`'s
    source, and five worked plugins, each a type-checked file.
  - `learn/choosing`: twelve design choices, what each tool chose, what it
    buys and costs, with a "choose another tool if" row that never names
    vx, and vx's own costs in plain words.
  - `learn/glossary`: seventeen terms defined once, with the name each of
    vx, Turborepo, Nx and Bazel uses.
- `learn/playground` runs vx's real planner, core's own source bundled for
  the browser, on the toy monorepo: edit files, the env and the specs, and
  read every key, hit or miss, and why a key moved by `vx why`'s rule. The
  configs are real `vx.config.mjs`, evaluated in a worker that can import
  only `@vzn/vx` and refuses what the CLI refuses. Core's parity rows hold
  its plan to `vx run --dry=json` (keys, statuses, deps, dispatch order);
  its glob matcher is a port of Bun's own.
- `learn/labs` breaks a build on purpose in the playground: a file no
  config mentions, an undeclared read and its stale hit, two tasks writing
  one output (core's refusal, verbatim), and a bad order on the scheduling
  simulator. Every state a lab reaches is held to the CLI.
- Checkpoints on the what-is, caching, correctness and playground pages
  ask which tasks rerun; the live planner marks each ticked task and says
  why, and the no-JavaScript answer is computed by the same planner at
  build time.
- The landing page leads with the problem ("Hundreds of commands. Which
  must run?") and three ideas (explicit inputs, a pipeline with seams,
  Bun-native speed), each linked to its Learn pages, with the numbers
  after.

## Docs and site

- Every page of the site and every module page was read against source
  and pinned to it (a change to the code that a page quotes fails a test).
  The introduction states vx's known limits in one place; the CI guide
  names the GitHub plugin; `--affected` includes dependents everywhere.
- Claims about other tools were checked against their own docs: five
  rows of the comparison page are corrected; the benchmarks no longer
  credit Turbo's daemon, which `turbo run` has not used since 2.9 (the
  numbers stand, the explanations changed); Nx's "no history first" is
  its last tie-break, not a rule over the queue.
- Every diagram renders: the extensibility guide's pipeline showed
  mermaid's error graphic (a node named `graph`), and every page with a
  diagram threw on load. The caching widget's keys render in monospace.

## Internals

- A per-file mutation sweep of core (items 342–572) with ~14k lines of
  witness tests behind the fixes above; the suite's twelve shards are
  weighed and balanced; the gate refuses a Bun below the floor before any
  shard starts; CLAUDE.md and STATUS trimmed to what a session needs. A
  value export nothing imports is a test failure; a `bun:sqlite`
  statement tally rides beside the profiler in the bench package.
- A second sweep (items 633–651) deleted every guard and duty line in the
  run's lifecycle, the runner, the save and restore paths, the local and
  layered caches, the remote prefetch, the scheduler, the task graph, the
  input resolvers, git enumeration, `--filter`/`--affected`, placement and
  the plugin host in turn, then the sandbox, the config loader and
  telemetry (652–654; the sandbox's one fix, its `~` path, is above).
  Each survivor became a row, a corrected comment or a deletion: three
  pieces of dead code went (a placement parameter no caller set, the
  filter's redundant bare-name branch, an unreachable admit arm) and a
  duplicated task-id splitter became one.
- Since item 672: the site's code is format-checked and type-checked by
  its own tasks and its prerender runs under Bun, not the PATH's Node; the
  site-wide laws read `.mdx`; core and every plugin package have a
  `source` task their dependants' suites key on, so a warm cache cannot
  replay a dependant's pass over an edit to the source it imports; the
  key fold moved to
  `cache/key-fold.ts` (behaviour-neutral, no key moved) so the playground
  bundles it without the store, and `vx why`'s diff join is a pure
  function the playground shares; the playground's glob port differs from
  Bun on 0 of 2,000,000 fuzzed pairs, and its planner serializes its own
  calls; two implied config-loader guards went; the site-redo plan, the
  in-browser planner spike and a STATUS trim.
- The roadmap to 1.0 (`design/roadmap-1.0.md`) defines feature complete
  and what remains before it.
