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

## Queued (from the stream's review, 2026-09-27)

- `--affected` refuses a task that an unaffected dependency declares:
  `b` depends on `a`, only `a` declares `dev`, only `b` changed →
  `No projects declare task(s): dev.` exit 1; the guard
  `projects.size < projectsWithConfigs.length` in `prepare.ts` skips the
  full-workspace check once the closure load brought `a` in.
- A `cache` factory that throws or returns a malformed layer skips
  plugin teardown (`prepare.ts`: the catch closes the local cache only),
  against `plugin.md` and item 1029.

## Leads for other streams

- **E:** a plugin command's plain `throw` (`commands.probe.run` throwing
  `new Error('boom')`) prints `vx: Error: boom` and a stack, and names
  no plugin (`src/cli/index.ts`), where every other stage says
  `plugin '<name>' failed in <stage>: boom`.
- **E:** `docs/cli.md`'s exit-code table omits nothing-affected (0), an
  unknown task (1) and a persistent task crashing after ready (1); each
  is documented only in prose.
