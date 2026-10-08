# Workstream DX — developer experience picks (owner, 2026-10-08)

The owner picked from a DX review: `vx why` walks to the root cause, the
live run predicts its end, the result line says what the cache saved,
paths and errors are clickable, the live view marks the critical path,
and log output reads better. Each must cost the warm path nothing.

- **DX-1.** The result line says what the cache saved:
  `3 tasks · 2 cached (66%) · 2.31s saved · 90ms`, the hits' stored
  exec times summed (what `--report` already printed). Summed in the
  pass the summary already makes over outcomes, and per outcome in the
  live logger. Row: `summary.test.ts` › "ends with the run in one line".
