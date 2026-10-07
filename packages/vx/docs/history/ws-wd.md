# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-12.** A persistent task that hit its readiness timeout reported a
  duration taken after the child exited, so a server trapping TERM showed
  the timeout plus the whole kill grace. `readyMs` now stops when the wait
  gives up. Row: `tests/persistent-ready-timeout.test.ts` › "a never-ready
  server reports the time it was waited on, not the kill grace after".
