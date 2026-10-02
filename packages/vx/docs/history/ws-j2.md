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
