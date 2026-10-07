# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-17.** `vx run --dry` called a server nobody requested
  `no-cache (would exec)`, with its p50 in the prediction, when every
  dependant was a local hit; the run never spawned it. The plan now asks the
  run's own gates and labels it `not started` (`not-started` in
  `--dry=json`). Row: `tests/persistent.test.ts` › "a server only cached
  dependants pulled in is not started when they all hit; a miss still waits
  for it".
