# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-19.** `vx run --filter x` (or `--affected`) with no task listed
  every project's tasks in the picker, and the anchored pick ran outside
  the filter. The menu now holds only the selected projects' tasks;
  `--affected` selecting nothing exits 0 as a run does. Rows:
  `tests/terminal.unsafe.test.ts` › "lists only the selected projects and
  runs the pick"; `tests/cli-picker.test.ts` › "lists only the projects a
  filter selected, and says when they declare no task".
