# Worker J2 — docs accuracy: the record

## Entries

- **J2-1** `modules/env.md` said every `binPaths` entry is prepended to
  PATH; since #2192 one holding `path.delimiter` is left out
  (`buildIsolatedEnv`). `modules/execute-task.md` named only the
  project's `node_modules/.bin`; the workspace root's is prepended too
  (`taskBinDirs`). Rows (`env-doc-drift` › every page stating the PATH
  prefix states all of it), red on both pages without the fix.
  `modules/cli-run.md` said a bare `--affected` falls back from
  `origin/HEAD` to `HEAD~1`, and `modules/affected.md`'s test list
  said the same; since D-93 a trunk branch (`origin/main`,
  `origin/master`, `main`, `master`) that is not HEAD comes between,
  and the workspace's `affectedBase` comes first. Row
  (`affected-default-pages`), red on both pages without the fix.
- **J2-4** Six module pages a fix left behind (the commit updated cli.md
  or caching.md, not the page for the file it changed).
  `modules/summary.md` said the result row's rate is over the tasks
  that have a cache; since #2212 a skipped task (and one still to run)
  is out of it. `modules/git-inputs.md` presented the blob-size check
  as catching a removed filter; since #2226 caching.md says a filter
  that kept the size passes. `modules/bin.md` said bin.ts never parses
  argv; since #1961 it answers a lone `--version` before loading the
  dispatcher. `modules/metrics.md`'s re-execution causes lacked #1928's
  continue-taint, so its "only when none applies" named `--no-cache`
  wrongly. `modules/cli-watch.md` said any task's input keeps a path
  from being dropped, and that projects come from `listProjects`;
  since 44a5f86 only the tasks the watch reaches count, and since the
  `discover` stage it lists through `discoverCliProjects`.
  `modules/logger.md` gained #2054's post-summary server stream. Rows
  (`module-page-claims`), red on each page without the fix.
- **J2-2** The failure recap's samples. `modules/framed-output.md`
  headed two tails and `… and 2 more failed` with `2 tasks`; the
  renderer counts all four. Both samples drew `◼` without the `︎`
  selector the renderer prints. cli.md said a tail reads stdout then
  stderr; a live-streamed task's reads as its chunks arrived (probed:
  `out1 err1 out2` live, `out1 out2 err1` buffered), and it omitted the
  dropped-capture note and the `, and` join. Rows (`cli-doc-drift` ›
  the failure recap samples are what the renderer prints), red on both
  pages without the fix.
- **J2-3** cli.md's `--report` sample read `8ms saved`, its two hits'
  restore times (5 + 3): the sum the paragraph under it says the header
  does not take (`savedMs` sums the entries' stored exec times). The
  sample's hits now store 2.01s and 640ms (`2.65s saved`), and the
  Status list names a skip's label as the renderer writes it,
  `skipped (blocked by lib#build)`. Row (`cli-doc-drift` › the --report
  sample is what the renderer prints), red without the fix.

## Leads for other streams

- **E** `vx last` labels every skipped row `after <id> failed`
  (`cli/last.ts`), where the run's Skipped section says
  `after <id> was aborted` for a block whose root a signal killed.

- **J2-6** #2227 dropped every native Windows branch, and two pages
  still described one: `modules/sandbox-runtime.md`'s Windows row said
  `probeSandbox` reports the sandbox unavailable and `exec.sandbox` is
  refused before the run (no such branch is left; under WSL the Linux
  row applies), and `execution.md` called the allowlist what a command
  needs on "\*nix / Windows". Row (`doc-references` › no page describes
  a Windows branch the source dropped), red without the fix.
- **J2-7** The sandboxing guide's grant table called `gitConfig`
  "inert: SRT drops the per-task flag"; since B-41 the run union carries
  it and each wrap sets it for its own task (`perTaskRun`), and the
  deny scan skips `.git/config` for that task, as schema.md and
  `modules/sandbox-runtime.md` already said. Row (`site-samples` › the
  sandboxing guide says what gitConfig grants), red without the fix.
- **J2-5** The config-eval cache's purity gate passes any import of
  `@vzn/vx/config` (`PURE_CONFIG_ENTRY`, since #2013), the entry every
  config `vx init` and vx-migrate write. `modules/config-cache.md`,
  `comparison.md` and the resolved-config-hashing post said a bare
  import of anything but `@vzn/vx` opts a config out, so a reader of
  any of them concluded the generated configs evaluate live every run.
  Rows (`doc-references` › comparison.md states the purity gate's
  three conditions, now with config-cache.md; `site-samples` › the
  bare imports it lets through are the two the gate passes), red
  without the fix.

- **J2-9** Blog posts pointed at guide sections under the titles of
  the guide pages the short site merged away: "Running tasks",
  "Dev & long-running tasks", "Lockfile-aware caching", "Caching" for
  the configure guide's "Why did it re-run?", and "`vx mcp` — AI
  agents". The dev-servers post also promised "the readiness patterns
  for the common servers"; the Dev tasks section has one Vite example.
  Each link now names `Guide › Section`. Probe, nothing to fix: the
  dev-servers post's foreground claims (a server exiting 3 under
  `vx run dev api` prints `exited with code 3; stopping 1 other
persistent task` and vx exits 1). Row (`site-samples` › a post's link
  into a guide section names the section), red on four posts without
  the fix.

- **J2-13** The why-did-this-rerun post's verdict table had six
  unchanged-key endings; `metrics.ts` has seven since #1928's
  continue-taint verdict ("neither run saved it: each ran beside a
  failed task …"). The configure guide had the row; the pin matched
  single-quoted notes only, and that verdict is a template literal, so
  it held neither page to it. The post now lists it, and the pin reads
  template literals too (an interpolated group reads `(…)`), expecting
  10; red on the post without the fix.
- **J2-11** The lockfile-aware-keys post said a `bun.lock` bump in
  vx's repo re-keys "that package's own tasks and its dependants'", and
  its excerpt "59 re-keyed tasks into 2". Measured 2026-10-02 (`run ci
--all --dry=json` keys before and after): an `astro` bump re-keys 6 of
  56 tasks with `bun()`, 56 without; a `protobufjs` bump re-keys all 56
  with it, since every digest folds the root's closure and the root
  links seven workspace packages. The post now gives both. Row
  (`site-samples` › the lockfile post measures what the root reaches),
  read from the manifests; red without the fix and with the narrow
  example swapped for `@types/bun`.

- **J2-16** The cascade-through-inputs post named one way a key is
  preliminary (a same-project upstream's outputs). `stable-keys.ts` also
  classes an upstream's root-anchored outputs, an uncached upstream
  that may write in the project (item 743), and a cached in-place
  rewriter the key does not fold (item 750), and every dependant
  inherits the class. Row (`site-samples` › the cascade post names
  every way a key is preliminary), gated on the source; red without
  the fix.
- **J2-10** The remote-execution post's "What goes remote" list said
  sandboxed and `exec.remote: false` tasks stay local but not that
  their dependants stay with them (`pinnedLocalSet` walks the dependant
  edges from every pinned task, as the CI guide says), and it named
  nothing of the runtime-probe rule (`withProbedRuntime`: a task whose
  key folds `cache.inputs.runtime` runs here; its dependants may go).
  Probes, nothing to fix: the post's one-artifact claim (vx-reapi stores
  the `tar.zst` as one CAS blob) and the lockfile-aware-keys post. Row
  (`site-samples` › the remote-execution post lists what placement keeps
  local), red without the fix.
- **J2-12** #2323 answers a scoped run's first 8 `transitiveDeps` asks
  by a search; `modules/package-graph.md` still said both closures are
  bitsets built on the first query, and the bitsets post said a filter
  over a thousand packages is "a handful of row ORs". Both now say
  when the graph searches. Rows (`module-page-claims` › package-graph.md,
  the count read from `EARLY_SEARCHES`; `site-samples` › the bitsets
  post says when the package graph searches instead), red without the
  fix.
- **J2-14** The watch-mode post's "always ignored" list left out
  git-ignored paths, which the loop drops through one `git check-ignore`
  per debounce window (a pid file or log a task writes there re-ran the
  loop forever before it), and called `--verbosity` refused where
  `--verbosity 0` is accepted. Row (`site-samples` › the watch post
  names what the loop ignores and refuses), read from
  `IGNORED_SEGMENTS`, `IGNORED_SUFFIXES` and `WATCH_REFUSED_FLAGS`;
  red without the fix.
- **J2-15** The keys-from-git post said three prunes run against an
  index id; #2076's blob-size check (A-60) is a fourth (a filter since
  removed wrote the blob, and git still calls the file clean), and a
  config that weakens git's stat (`core.trustctime=false`,
  `core.checkStat=minimal`) trusts no id at all. `caching.md` had both.
  Row (`site-samples` › the keys-from-git post names every way an index
  id is distrusted), gated on `git-inputs.ts`; red without the fix.
- **J2-17** The strict-output-ownership post said the benchmarks'
  restore and no-op rows sit within a few milliseconds because of the
  "current tree" short-circuit. The restore row deletes the outputs
  first (`vx-bench/run.ts`), so it extracts every artifact; the
  short-circuit is the no-op row alone (475 against 743 ms in
  `results.json`). Row (`site-samples` › the output-ownership post reads
  the benchmark rows as they are measured), read from the harness and
  `results.json`; red without the fix.

- **J2-18** The sandbox post said a sandboxed task that reads a file
  its inputs never named fails on the denied read, beside a sample
  granting `read: ['.']`, which lets that read through: a violation is
  a denial, and only the grants deny (`sandbox-request.ts` derives
  nothing from `cache`). The post now says the grants judge it and that
  reads granted no wider than `cache.inputs` make the denial the
  under-declaration. Row (`site-samples` › the sandbox post judges a
  violation against the grants); red without the fix.

- **J2-19** The pipeline-with-seams post's stage diagram ran
  `config → project`, skipping `discover`, which its own table (pinned
  by item 343) lists second. Row (`site-samples` › every arrow chain of
  the pipeline stages is PLUGIN_HOOKS in order), over every site page
  and core doc; red on the post without the fix.

- **J2-20** The one-binary post installs from npm and then says no
  runtime boots before vx's own code runs; the npm package's `bin` is
  `launcher.cjs`, a Node script that spawns the platform binary (one
  Node start first, ~65 ms by its own comment). It also said the
  package ships the binary, which a per-platform optional dependency
  carries. Both now say so. Row (`site-samples` › the one-binary post
  says the npm command is a Node launcher), read from `build-npm.ts`
  and the launcher; red without the fix.

- **J2-21** The no-daemon post said Turborepo is deprecating its daemon
  "as of 2.10"; turbo's 2.8.11 release notes deprecate it for
  `turbo run`, as `comparison.md` says. The no-choice post measured Nx's
  3.59 s "with the daemon running"; `compare.ts` runs every runner with
  `CI=1`, Nx's daemon off, and the honest-benchmarks post said both
  ran "with their daemons on". Row (`site-samples` › the posts state the
  daemons as the benchmark ran them), reading the version from
  `comparison.md` and the footing from the harness; red without the fix.

- **J2-22** J2-17's class on a second page: the concepts page's "vx
  alone" bullet said a restore costs about the same as an untouched
  tree, of `vx-bench/run.ts`, whose restore row deletes the outputs
  and extracts every artifact (239 against 906 ms at 1,000 projects in
  `benchmarks.md`). Row (`site-samples` › the concepts page reads
  run.ts's restore row as it is measured); red without the fix.

- **J2-23** The telemetry post and `vx.workspace.ts`'s comment said
  `@vzn/vx-otel` exports traces and metrics; it exports logs too, on by
  default when an endpoint is set (`OTEL_LOGS_EXPORTER=none` turns them
  off). The plugins guide, the architecture page and the plugin's README
  had it. Row (`site-samples` › every page naming what vx-otel exports
  names each signal), the signals read from `plugin.ts`; red on both
  without the fix.

- **J2-24** Owner rule, no speed claims for Turbo/Nx-mapped runs:
  `vx-migrate`'s README gave three mapped runs' warm wall times ("a run
  that is otherwise the same ~200 ms warm", "~96 ms of a 417 ms warm
  run on refine", "median 284 → 243 ms"). The stage costs it states
  (the mapping's 42 ms, the key's 43 ms) stay: they are what the bridge
  adds, not a run's speed. Row (`site-samples` › no migration page
  times a mapped run), over the README, the migrate guide and the
  from-\* posts; red without the fix, and it found the third after
  the first two were gone.

- **J2-25** Only `@vzn/vx` is on npm (0.0.367; every plugin 404,
  checked 2026-10-02). J-93 put the "first publish is pending" note on
  the README and the CI guide, pinned by name; the migrate and plugins
  guides carry it too, but the quickstart's `bunx @vzn/vx-migrate` and
  the configure guide's `bun add -d @vzn/vx-lockfile` sent a reader to
  a 404 with no word. Both now say it. Row (`site-samples` › every Docs
  page that installs, runs or imports a plugin says npm has none yet),
  the plugins read from the manifests and the pages found; red on both
  without the fix.

- **J2-26** #2392 moved an entry's stdout out of the `entries` row into
  `entry_stdout` (so the run-end `accessed_at` bump stops rewriting up
  to 16 MB a hit); `modules/cache.md`'s `get` bullet, `optimizations.md`
  row 17f, the why-vx-is-fast post and the one-command-per-task post
  still put it in the row. Row (`site-samples` › the pages say where an
  entry stdout lives), gated on `schema.ts`; red without the fix.

- **J2-27** #2288 (docs untouched) stopped a bare `--affected` asking
  git twice: `verifyRef` skips a ref the default base's search already
  resolved, and a `HEAD~n` base is its own merge base, so no
  `git merge-base` spawns. `modules/affected.md`'s algorithm still had
  both spawns unconditional, and its step 2 rendered "- unstaged
  changes" as a nested list item. Row (`module-page-claims` ›
  affected.md), gated on `affected.ts`; red without the fix.

- **J2-30** #2417 (docs untouched) drops an Nx output that resolves
  outside the workspace (an old generator's
  `reportsDirectory: "../../coverage/<lib>"`) with a todo, since core
  refuses `..` and the written config failed to load. The support
  table, its contract and the vx-migrate README still made every output
  outside the project a workspace file. Row (`site-samples` › the Nx
  output pages say one outside the workspace is dropped), gated on
  `nx-outputs.ts`; red without the fix.

- **J2-31** #2152 names a dependency server that dies while the graph
  still runs at that moment, with a line ending
  `while the run went on`; `schema.md` took it, `modules/orchestrator.md`
  did not, and its end-of-run line was item 892's form, without the
  `before the run stopped it` the code prints. Row
  (`module-page-claims` › orchestrator.md), both lines read from
  `run.ts`; red without the fix.

- **J2-32** #2424 points a write refused under the host's shared temp
  directory at `$TMPDIR` (the task's own, empty at its start) instead of
  a grant, which would open `/tmp` to every write of the task; it
  updated `schema.md` alone. `modules/sandbox-runtime.md` and the
  sandboxing guide still said every refused write outside the project
  names the directory to grant. Row (`site-samples` › the sandbox pages
  say a refused temp write points at $TMPDIR), gated on the hint's text;
  red without the fix.
- **J2-33** Plugin READMEs left options out: vx-otel's showed five of
  its ten (`timeoutMs`, `compression` and the three per-signal
  endpoints only in the plugins guide), vx-github's had no `checkName`
  (default `'vx'`), and vx-reapi's no `instanceName` (only its env var),
  `headers` (gRPC metadata on every call, where a hosted server's API
  key goes) or `tls` (a bare `host:port` stayed plaintext). Row
  (`site-samples` › every plugin README names each option its factory
  takes), the fields read from each options interface, test seams left
  out; red on the three without the fix.

- **J2-34** vx-mcp's README rows for `explainCacheKey` and
  `whyDidThisRerun` never named their `taskId` argument (the question
  showed `pkg#build`, the call needs the key). Row (`vx-mcp`
  `readme-tools` › README names each tool's arguments), every
  `inputSchema` property read from `listTools()`; red on both without
  the fix.

- **J2-35** #2442 names a server `holdPersistent` hands back (the watch
  loop's) that dies on its own after the run returns; it updated
  `cli.md` and `execution.md`, and `modules/orchestrator.md`'s
  `holdPersistent` sentence still had the caller owning the servers
  with no word of it. Row (`module-page-claims` › orchestrator.md, a
  held server), gated on `run.ts`; red without the fix.

- **J2-36** The sandboxing guide's step 4 says an undeclared read fails
  the task and names the path; a persistent task (a dev server) is
  never traced, so its refusals are named nowhere and read as the
  tool's own `ENOENT`. #2451 tells a failing one so; the guide had no
  word of servers at all. It now says it under "What can't be
  sandboxed". Row (`site-samples` › the sandboxing guide says a server
  is never traced), gated on `execute-task.ts`; red without the fix.
- **J2-28** The landing said "`bunx @vzn/vx-migrate` or `vx init`
  gives a temporary start": the migrator writes the native config, the
  destination, not a temporary start, and npm has no copy of it yet
  (J2-25's class, on the one page that row cannot see: it scans
  Markdown). It now says `vx init` is the temporary start and the
  migrator writes native config, its first publish pending. Row
  (`landing` › shows how to start, the sentence it pins); red without
  the fix.

- **J2-29** J-102's class on the landing picture: its fifth callout
  said "A read you did not declare fails the task", beside a drawing
  of `app#build` reading `../secrets.env`, a read the sandbox refuses
  silently (the wall), and a read outside the workspace is allowed.
  It now says a workspace file you did not declare is out of reach, as
  J-102 made the pillar say; the trace row that backs it (on the task's
  own file) names the scope. Row (`landing` › the six lines, the
  callout it pins); red without the fix.

- **J2-8** The configure guide said "a task sees only the variables
  you pass it" and gave `CI` as a `passThrough` example, and the
  explicit-over-magical post said env reaches a task only through
  `exec.env` (one-command-per-task: an environment built from it): `CI`, `PATH`, `NODE_OPTIONS` and the rest of
  `ESSENTIAL_ENV` reach every task undeclared. Both name the allowlist
  now; the guide's example is `GITHUB_ACTIONS`. Probes, nothing to
  fix: the-sandbox, values and what-vx-is posts. Row (`site-samples` ›
  no page says a task sees only what it declares, past the allowlist),
  red without the fix. The Troubleshooting page (#2470), added since, said "vx passes only what you list" too; it names the allowlist now, and the row holds it.

- **J2-37** J2-18's class on the Troubleshooting page (#2470): for a
  hit after a change to a file missing from `cache.inputs.files`, it
  said `exec.sandbox` refuses a read you did not declare; the sandbox
  judges its grants, so it refuses that read only when reads are
  granted no wider than the inputs. Row (J2-18's, widened to the page);
  red without the fix.

- **J2-38** #2492 warns on a member directory that holds a vx config
  but no `package.json` and skips it; the Troubleshooting page's
  `not inside a project` fix does not reach that case. The page quotes
  the warning and its fix: add a `package.json` with a `"name"`.
  Audited clean: `schema.md`'s error table and defaults, `caching.md`'s
  constants, the capture and recap limits, `vx cache prune`'s flags,
  the module pages' defaults, the `VX_*` names. Row
  (`site-troubleshooting` › names the skipped config dir warning), red
  without the fix.

- **J2-39** Eight signatures on the module pages lacked a parameter
  their source takes: `deniedCalls` (`cwd`, `reads`),
  `resolveSandboxConfig` (`walls`), `parseStraceViolations`
  (`widened`), `sandboxRequestFor` (`cacheDir`), `streamToString`
  (`retain`), `migrateScripts` (`outside`, `outsideDir`),
  `sweepConfigs` (`tasks`), `makeRootEventFilter`
  (`claimedRootFiles`). Each page lists them now. Row
  (`module-page-claims` › a module page lists every parameter its
  function takes), generated from every page's `export function` and
  the source's top-level parameter count; red without the fix.

- **J2-40** Six interfaces on the module pages had fallen behind their
  source. `cache.md`'s `CacheLayer` listed 9 of its 25 members and
  `orphanStats`, which only `Cache` has; `CacheKeyInput` lacked
  `upstreamGraft`, `CacheEntry` four fields, `RunRecord` the
  `cached` and v27 columns, `AffectedArgs` `untracked`, `DeniedCall`
  `read` and `dir`. Each lists its source's members now
  (`ExecuteArgs` says it is abridged, and the row honours a `// …`).
  Row (`module-page-claims` › a module page lists exactly the fields
  its interface has), red without the fix.

- **J2-41** `cli.md`'s `vx info --format json` bullet gave `sandbox` as
  `{ available, reason, declared }`; the object carries `untraced` too,
  which the same section names as a fact. The bullet lists it now. The
  top-level row held only field names; a sibling row
  (`cli-doc-drift` › gives each object field the keys the object
  carries) holds each documented shape to `InfoFacts`, red without the
  fix.

- **J2-43** #2546 made `vx init` keep each config a member already has
  and write the rest, listing the kept ones under `kept`;
  `modules/migration.md` still said any existing config aborts the
  whole run. The guard bullet now splits the callers: `vx init` keeps,
  a migration refuses. Row (`module-page-claims` › migration.md's
  overwrite guard says vx init keeps a member's config), red without the
  fix.
- **J2-42** #2537 named "the `WireOnly` keys" in the vx-reapi README
  while #2541 inlined that type, so the README named a type nothing
  declares. The sentence names the four keys alone. Row
  (`plugin-exports-documented` › names no type-shaped identifier its
  package and core lack), red without the fix.

- **J2-44** Eighteen names the module indexes export were in code on no
  module page: `SchemaReset`, `OUTPUT_DIRS_CAP` and `OUTPUT_DIRS_RACY_MS`
  (cache); `formatRunReportMarkdown`, `RunEventSubscriber`,
  `FlakyCandidate`, `DeriveStableKeysArgs` and `StableKey`, the plugin
  installer's `InstallPluginsArgs`, `PluginContext`,
  `PluginHookHandlers` and `PluginHookName`, and the metrics argument
  and row types with the `explainCacheKeyQuery` alias (orchestrator);
  `MOVED_VERBS` (util). Each page that owns the file names them now.
  Row (`module-page-claims` › every name a module index exports is in
  code on a module page), red without the fix.

- **J2-45** `telemetry.md`, `architecture.md`, two blog posts and
  `telemetry.ts` called a telemetry record immutable. Every sink receives
  the same object, unfrozen, so a change one sink makes reaches the next
  (probed; `task.end` also hands sinks the outcome's own `outputs`). Each
  says plain-data records now, and the module page says a sink must not
  change one. Rows (`site-samples` › no page calls a telemetry record
  immutable: the sharing as a control, the wording red without the fix).
- **J2-46** Two Invariants claims past their source: `task-hash.md` said
  any change to what joins the key needs a `CACHE_VERSION` bump, where
  `caching.md` exempts a change in which values flow into an existing
  field; `telemetry.md` said consumers reject unknown majors, where the
  version is one integer no first-party sink reads. Rows
  (`module-page-claims` › task-hash.md claims the bump rule caching.md
  states; `site-samples` › telemetry.md claims no receiver check the
  sinks lack), red without the fix. Invariants audited clean so far:
  stable-keys, fingerprint-watch, run-context, download-policy,
  remote-prefetch, run-report, telemetry-host, util-hash, timing, events.

- **J2-47** `upgrade.md` said compiled-binary detection uses NOT
  `import.meta.path`; `isCompiledBinary` ORs it in last (it was the only
  check in the 2026-06-15 bug). The page and the source comment say
  last fallback now, and the Invariants prose names `replaceBinary`'s
  `starts?`. Row (`module-page-claims` › upgrade.md's detection
  invariant names every path it checks), red without the fix.
- **J2-48** `plugin.md` listed the stages whose throw fails the run,
  naming the plugin, as `config`, `project`, `graph`, `key` and
  `schedule`; `discover` and `fingerprint`'s `affected` pass the same
  guard. Row (`module-page-claims` › plugin.md's fail-the-run list is
  the hooks plugin-host guards), generated from `safe()`'s call sites;
  red without the fix. Invariants audited clean: config-cache,
  deferred-outputs, plugin-commands, plugin-host, local-shortcircuit,
  config, history, lockfile, kill-tree. That ends the Invariants audit.

- **J2-49** `cli-help.md`'s Purpose said the help text is the
  fall-through after `vx <unknown-command>`; that path prints one line
  naming the verb and pointing at `vx help`. It names the paths that do
  print it now, a bare `vx` among them. Row (`module-page-claims` ›
  cli-help.md's Purpose names the paths that print the text), red
  without the fix.
- **J2-50** `util-paths.md` framed `toPosix` as keeping keys stable for
  a workspace cloned on native Windows, which vx does not run on: every
  supported platform separates with `/`, so the conversion is a no-op.
  The Purpose and Why say so and point Windows at WSL. Row
  (`doc-references` › no page describes a Windows branch the source
  dropped, widened), red without the fix. Purpose sections read clean so
  far: chained-cache, affected, bin, cache, deferred-outputs, env,
  filter, fingerprint, plan, plan-format, telemetry-host,
  util-edit-distance, util-real-path, cli, cli-format, cli-watch,
  colors, dependency-spec, execute-task, history, nested-dirs, options,
  prepare, run-context, stable-keys, tally, task-graph.
- **J2-51** `sandbox-runtime.md`'s Purpose said `executeCachedTask`
  uses it; since the executor seam the local executor calls
  `runSandboxed`, and only a persistent task's path in `execute-task.ts`
  wraps a command itself. Row (`module-page-claims` › sandbox-runtime.md's
  Purpose names who calls it), red without the fix.
- **J2-52** Three Purpose sections behind their source: `timing.md`
  counted `prepareRun`'s marks as seven (it records eight), `doctor.md`
  gave `sandbox` without `untraced` (J2-41's drift on another page), and
  `plugin-host.md` named three of the eight stages the host runs. Rows
  (`module-page-claims` › timing, doctor and plugin-host Purpose sections
  match the source), each generated from the source and red without the
  fix.
- **J2-53** `util-settle.md` and `settle.ts`'s comment said two graces
  share `killGraceMs` and `VX_KILL_GRACE_MS` overrides both; the signal
  teardown is a third. Row (`module-page-claims` › util-settle.md names
  every grace killGraceMs serves), red without the fix. That ends the
  Purpose audit: every module page's Purpose read against its source.

- **J2-54** `architecture.md` read claim by claim against source: its
  "What's intentionally absent" bullet listed the pipeline stages a
  plugin fills without `discover` (J2-48's drift on another page). Row
  (`architecture-doc-drift` › architecture.md's absent-JS-tasks bullet
  names every hook), generated from `PLUGIN_HOOKS`, red without the fix.
  Checked clean: the package and module tables (eight modules, three
  root files, nine example seams, 46 façade names), the orchestrator
  inventory, the import matrix against the real edges, the capability
  table, the repo's own `vx.workspace.ts`, the cache cluster, the
  scheduler, the runner, the data flow, the loader, the replaceability
  paths, the remote-cache subsystem and the `runs` columns.
