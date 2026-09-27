# Stream C — scheduler and run lifecycle (plan-2026-09-27): merged items, one entry per PR

## C-1: carry the `--continue=always` taint through a restore-tier hit

A stale hit. Under `--continue=always` a task behind a failure runs but is
never saved, and the taint passes to everything built on it. The tracker
judged each task at dispatch, from the upstream outcomes it saw, and a
dependent asked whether its upstream had been tainted. A confirmed local
hit runs on the restore tier, ahead of its deps, so it was judged against
holes and recorded clean: `gen` (failed) → `pack` (a hit) → `ship`
(executed) saved `ship` over `gen`'s partial output on its healthy key,
and the next healthy run restored it. The same graph with `pack`
executing never saved `ship`. The tracker now learns every settled
outcome (`onFinish`) and reads a task's taint from its deps' settled
outcomes, iteratively and memoized once they have all settled. A
restore-tier task's dependents are released only once its own deps have
settled (item 963), so the answer is complete when asked. Rows:
`continue-taint.test.ts` (red on main: `ship` read `cache-hit` in the
healthy run) and `taint-tracker.test.ts` (the early judgment, its
control, and a 50,000-deep chain of hits; each red with `settled` a
no-op).
A mutation sweep of `scheduler.ts` found the item-963 block held for
one hop only; `scheduler.test.ts` now holds it through a skipped task,
through a second hit and from an `aborted` dep (each row red under its
mutant).

## C-2: run a task whose key folds a runtime probe on this machine

A stale hit (F's vx-reapi probe P2). `cache.inputs.runtime` and
`workspaceRuntime` are answered by the submitter (`node -v`) and folded
into the key, but a remote worker ran its own runtime: a Node 20 worker's
output was saved under a Node 22 key. No executor can prove its worker
matches, so `pinnedLocalSet` pins such a task. Its dependants stay free:
they fold the probe through its input key, and their output does not
depend on this machine's runtime. Core-side for every executor, so the
`vx-reapi` plugin needs no change. Row: `placement.test.ts` (red without
the change).

## C-3: judge an `--affected` task name by every loaded project

Under a diff-chosen scope a bare name only unaffected projects declare is
not a typo (item 1024). The guard asked the whole workspace only when
the load was partial: `b` depending on `a` loaded `a` for the closure,
the load was whole, the check was skipped, and `vx run dev
--affected` said "No projects declare task(s): dev" and exited 1 though
`a` declares it. Names a loaded project declares now drop first; the
rest of the workspace is loaded only for names still unjudged. Row:
`affected-sparse-tasks.test.ts` (red without the change).

## C-4: tear the plugins down when a cache factory fails

The cache factory runs inside `prepareRun` before the span that tears
down on a throw, and its catch closed the local cache alone: a `cache()`
that threw or returned something off-contract left every plugin's
teardown unrun, leaking what other factories opened, once per `vx watch`
cycle (`plugin.md` and item 1029 promise it). Also de-claims two
comments: frozen mode checks no config bytes on the run path (`vx lock
--check` does), and a graph hook has no resources to adjust. Rows:
`plugin-teardown.test.ts`, a throwing and an off-contract factory (red
without the change).

## C-5: open the index read-only when loading resolved projects

`loadResolvedProjects`, what `vx show` and `vx mcp`'s `listTasks` read,
opened the cache as a run does: it created `.vx/cache/` where none
existed and reset an earlier schema's index, run history included. It
opens it as `vx last` does now (`Cache.inspect`); an index it refuses
serves nothing and the configs evaluate live. Row:
`scoped-config-loading.test.ts` (red without the change).

## Leads for other streams

- **E:** a plugin command's plain `throw` (`commands.probe.run` throwing
  `new Error('boom')`) prints `vx: Error: boom` and a stack, and names
  no plugin (`src/cli/index.ts`), where every other stage says
  `plugin '<name>' failed in <stage>: boom`.
- **E:** `docs/cli.md`'s exit-code table omits nothing-affected (0), an
  unknown task (1) and a persistent task crashing after ready (1); each
  is documented only in prose.
- **A:** the `local-shortcircuit.ts` sweep's survivors (2026-09-27):
  per-task path lets a stable MISS into the restore tier (no row), one
  throwing `cache.get` or `gitFilesCache` rejects the whole classify,
  the "workspaceFiles INPUTS" row is disarmed (its reader misses on the
  warm run), and the reach/propagation exclusions (equal prefix,
  ancestor prefix, root project, every dependant, transitive dependants)
  hold no row.
- **B:** `sandbox-usage.unsafe.test.ts` › "is not reported, since what
  bwrap's namespace used never reaches the wait" failed two of two full
  gates on a timing floor (`>= 300`, got 246 ms), green alone.
- **F:** `wedged.test.ts` RST_STREAM rows raced (`sent: 0`) under gate
  load twice.
- **G:** `vx-migrate/src/nx/index.ts` imports `type Gaps` and never uses
  it (a lint warning).
- **B:** the SIGKILL leak in `keep-alive.test.ts` (the "backgrounded
  server/child" rows, macOS CI and 4 of 40 local runs at 10-way load)
  is a real window, not a flake: `spawnGuarded` lists a task's group
  with the guard only after `spawn()` returns, the child runs first
  under load, and a `kill -9` before that pipe write leaves the group
  unlisted (the guard logged an empty list at EOF in every leaked run).
  Proposed fix: the child lists itself before it runs anything (the
  guard pipe passed as an extra fd; the task shell writes `+$$`, closes
  the fd, then runs the command), and the guard dedupes ids.
