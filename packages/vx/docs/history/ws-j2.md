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

- **J2-15** The keys-from-git post said three prunes run against an
  index id; #2076's blob-size check (A-60) is a fourth (a filter since
  removed wrote the blob, and git still calls the file clean), and a
  config that weakens git's stat (`core.trustctime=false`,
  `core.checkStat=minimal`) trusts no id at all. `caching.md` had both.
  Row (`site-samples` › the keys-from-git post names every way an index
  id is distrusted), gated on `git-inputs.ts`; red without the fix.
