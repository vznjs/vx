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
- **DX-2.** `vx why` names the root cause in one call: an upstream row
  is only a carrier, so it follows each moved dependency in the same
  run down to the tasks whose own inputs moved and prints
  `app#build ← lib#build ← file packages/lib/src/index.js`, with
  `what to do` for those kinds. JSON carries it as `roots`. Read-only
  over history; the run path does not change. Row: `why.test.ts` ›
  "env, package, workspace fingerprint, config and upstream".
- **DX-3.** The live run predicts its end: a second in, the `time` row
  adds `~3s left` from each unfinished task's executed p50
  (`orchestrator/forecast.ts`); a supported terminal shows tab progress
  (OSC 9;4) and, after 10 s, a desktop notification (OSC 9). A run that
  ends inside the second reads no history, so the warm path is
  unchanged. Rows: `forecast.test.ts`.
- **DX-4.** The live worker rows mark the critical path: a second in,
  the running task the longest unfinished chain waits on reads
  `critical path`, and every row says `blocks N`, its unfinished
  dependents. Computed in the forecast's pass, twice a second at most,
  live region only. Rows: `forecast.test.ts` › "names the running task".
- **DX-5.** A config refusal names its line: `packages/b/vx.config.ts:4:15: tasks.build.exec has unknown field "comand"`,
  with the lines up to it and a caret. Read from the message the schema
  already writes (so a refusal from the config worker is placed too),
  located by walking the path's keys in the source; a field the file
  does not hold prints as before. Error path only. Rows:
  `config-frame.test.ts`, `config-error-audit.test.ts`.
