# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-18.** The picker wrote its menu and prompt to stdout, so
  `vx run > out.txt` on a terminal put them in the file and sat on a
  blank screen waiting for a number. They now go to stderr; only the run
  reaches stdout. Row: `tests/terminal.unsafe.test.ts` › "asks on the
  terminal, and only the run reaches the file".
