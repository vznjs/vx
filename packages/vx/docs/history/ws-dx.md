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
- **DX-6.** A task frame prints its output as one `├─ OUTPUT` section
  in the order vx read it (owner's pick, 2026-10-08), not STDOUT then
  STDERR: a test runner's failure on stderr stays beside the test that
  printed it on stdout. Stderr lines render red when colour is on, and
  plain output stays the task's bytes; a line the task coloured keeps its colours. The logger keeps
  one ordered buffer per task instead of two. Rows:
  `framed-output.test.ts` › "interleaved streams keep their order".
- **DX-7.** A cache hit replays stderr too (owner, 2026-10-08: "store
  mixed same as in output"). The entry's output is both streams in the
  order the run printed them, one string (`output-log.ts`: RS + `e` /
  `o` where the stream switches, a literal RS doubled), so every layer
  carries it as it carried stdout. `execute-task.ts` keeps it from the
  live callbacks, masked, in one `BoundedCapture`; the runner retains
  nothing. `vx-cache-v42`. Rows: `replay-fidelity.test.ts` › "stderr
  between two stdout lines replays between them", `output-log.test.ts`.
- **DX-8.** A failed task's frame links each path it prints that names
  a file (`src/a.ts:12:5`, `src/a.ts(12,5)`) to that file under the
  task's project (OSC 8), so a click opens the right file from a
  monorepo's root, where the terminal's own detection resolves against
  the shell's directory. The text stays the task's bytes; a success, a
  pipe, CI and a terminal not known to open links (tmux, screen
  included) get none. One stat per path, failed frames only. Rows:
  `path-links.test.ts`.
- **DX-9.** An agent reads why a task failed without the terminal. A
  failed task's output (both streams, secrets masked, the first 8 KiB
  and last 56 KiB, ANSI stripped) and the files it names
  (`{ file, line?, col? }`, `fileLocations` over the link pattern) are
  written at run end to `<cacheDir>/failures/<runId>.json`, the newest
  50 kept. Files, not a cache.db table: a table would need a
  `SCHEMA_VERSION` bump, which resets every shared store (coordinator,
  2026-10-08). A refused write costs only the output. A task that saves
  nothing keeps a failure-sized capture; a green run writes nothing.
  `vx last --format json` adds `output` and `locations` to failed rows;
  `@vzn/vx-mcp` adds `getFailures`. Rows: `run-output.test.ts`, vx-mcp
  `tools.test.ts` › getFailures.
- **DX-10.** `vx run --affected --dry` says why each requested task
  was kept: `affected: <file> changed (an input), via lib#build` under
  its row, and `affected: { kind, file?, project?, via? }` in
  `--dry=json` (`schemas/plan.json`). Kinds: `input`, `project`,
  `package`, `named`, `selected`. Gathered only when `planRun` asks
  (`AffectedExplain`), so a run pays nothing. Rows:
  `affected-dry-reasons.test.ts`.
- **DX-11.** An agent skill ships in `@vzn/vx`: `skills/vx/SKILL.md`
  teaches run, `--affected --dry=json` reasons, `vx last --failed
--format json`, `vx why`, `vx info` and the `vx mcp` tools. The
  agents guide says how to install it (copy into `.claude/skills/vx/`).
  `agent-skill.unsafe.test.ts` holds its commands to the verbs and
  flags vx accepts and its MCP list to `@vzn/vx-mcp`'s tools.
- **DX-12.** `vx info` reads the cache against `cacheRetention`:
  `cache entries: 812 (3.0 GB of 10 GB, 30%)`, a `cache retention` row
  saying what each run's end evicts, and paths under the home
  directory as `~/…` (pretty only; the JSON stays absolute and gains
  `cacheRetention`). Rows: `show-info.test.ts` › the rendered rows.
