# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-13.** Ctrl-C in `vx watch` wrote `vx watch: stopped` the moment
  the signal landed, so the aborted cycle's task line and summary printed
  below it while its children were still being torn down. It is now the
  last line, written once the loop is down. Row:
  `tests/watch-signals.test.ts` › "SIGINT during a cycle prints stopped
  last, once the cycle is down".
