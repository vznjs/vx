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
- **DX-13.** Run JSON (`--summarize`, `vx run --format json`) gains
  `savedMs` and each hit's `storedDurationMs`; `--dry=json`'s
  `predicted` gains `criticalPath`, the would-run tasks with history
  on the `wallMs` chain. Rows: `run-artifacts.test.ts` › a hit's
  stored usage; `plan-predict.test.ts` › time prediction.
- **DX-14.** MCP `whyDidThisRerun` answers what `vx why --format json`
  does: `diff` and `roots` beside the verdict. `rootCauses` moved from
  `cli/why.ts` to `orchestrator/metrics.ts` so both read one walk;
  the façade gains `cacheKeyDiff` and `rootCauses`. Row:
  vx-mcp `why-parity.test.ts`.
- **DX-15.** MCP `planTasks`: `vx run <tasks> --dry=json` through the
  CLI as a child, as `runTasks` runs `--format json`; one argv builder
  and one spawn serve both. Rows: vx-mcp `plan-tasks.test.ts` (equal
  to the CLI's plan, nothing ran; a refusal carries no plan).
- **DX-16.** MCP `listTasks` takes `filter` and `affected`: the CLI's
  `vx show --format json` makes the selection, then the resolved list
  narrows to it; `project` beside either is refused. Rows: vx-mcp
  `list-tasks-scope.test.ts`.
- **DX-17.** Failed-task logs an agent can fetch (roadmap #2), beyond
  #3273's failure output: `vx last --log <task>` and vx-mcp's
  `getTaskLog` read one task's output from history, a failure's kept
  output or a cached task's entry log, so a passing task's log reads
  too. Core `taskLog` (run-failures.ts) serves both. Rows: core
  `last-log.test.ts`, vx-mcp `task-log.test.ts`.
- **DX-18.** `vx init` first run, walked on a fresh Turbo and a fresh
  Nx repo without a TTY: both migrate native with no prompt and end on
  `next: … vx run build --all`. The one rough edge was a second
  `vx init`: it fetched vx-migrate, which refused to overwrite its own
  configs, exit 1. It now says vx is set up, with the next step, exit 0. Row: `init.test.ts` "a second vx init after the native migration".
- **DX-19.** DX #2, no TTY-only path for agents: `vx run` with no task
  under `--format json` or `--dry=json` refused only without a TTY, so
  an agent on a pty waited at the picker. It now refuses there too,
  `VX_E_USAGE` on stdout. The other prompt, vx-migrate's native/keep,
  already answers native without a TTY. Row: `run-exit-codes.test.ts`
  "a JSON answer never opens the picker".

- **DX-20** Agent-trial fixes the docs could make (org/devex/agent-trial.md
  rows 1, 2, 9, 11). The skill names raw-markdown page paths for when
  github.io is unreachable and says adoption does not add `vx mcp`; the
  quickstart and migrate guide carry a `bun add -d` line; `vx last`'s
  schema says `cached` is "declares a cache", not "hit". Rows 3, 5–8, 12
  were already fixed on main and wait for a release.

- **DX-21** `vx why` after a failed run (agent-trial row 10). The failed
  run saved no fingerprints, so the next run's why named only the key
  change. It now diffs against the last run that saved an entry and
  names the file the fix touched. Row: `metrics.test.ts` "diffs against
  the last run that saved an entry".

- **DX-22** MCP `getConfig` (roadmap DX #3, MCP parity): `vx show`'s
  JSON answer through MCP, so an agent reads what a task
  declares (inputs, outputs, env, sandbox) before changing it. Rows:
  `vx-mcp/tests/config.test.ts`.

- **DX-23** `vx lock --check --format json` and MCP `checkLock` (roadmap
  DX #3): the audit as `{upToDate, audited, notAudited, problems}`, exit
  code unchanged, schema `schemas/lock.json`. Rows: `cli-json-schemas`,
  `vx-mcp/tests/check-lock.test.ts`.

- **DX-24** `pnpm exec vx init` failed with "installing vx failed (…
  exited -1)" (Growth's trpc trial): PATH held pnpm's placeholder with
  no shebang (ENOEXEC) and the spawn error was dropped. When PATH's
  manager cannot be spawned, vx-migrate now runs the one that launched
  it (`npm_execpath`), and names the spawn error. PATH stays first: the
  try-it rows' npm stand-in caught an execpath-first draft bypassing it.
  Rows: `adopt.test.ts` "install when PATH holds an unrunnable manager".

- **DX-25** MCP `pruneCache` (roadmap DX #3): `vx cache prune`'s JSON
  answer on the cache the other tools read; a dry run unless the call
  says `dryRun: false`. Rows: `vx-mcp/tests/prune-cache.test.ts`.

- **DX-26** A failed pnpm install in vx-migrate names
  `minimumReleaseAgeExclude` and the `@vzn/*` packages to list there:
  pnpm 12 refuses releases newer than its `minimumReleaseAge`, and vx
  releases daily. vx never loosens that setting itself; the migrate
  guide says the same. Rows: `adopt.test.ts` "names
  minimumReleaseAgeExclude when pnpm ran and refused".

- **DX-27** The init plan as data (roadmap DX #3):
  `vx init --dry --format json` (and vx-migrate's, which a Turbo or Nx
  repo hands to) prints `schemas/init.json`: each file with its text,
  `kept`, `replaced`, `todos`, `notes`, `next`. MCP `planInit` returns
  it. Rows: `cli-json-schemas.test.ts`, `adopt.test.ts` "--dry --format
  json prints the plan", `vx-mcp/tests/plan-init.test.ts`.

- **DX-28** `vx docs <query>` (roadmap DX #4, Turbo 2.8's `turbo docs`):
  searches seven reference pages offline. They ship in the npm package
  (`build-npm.ts`) and the compiled binary (text imports in
  `docs-corpus.ts`). A section must hold every word, and a heading
  match ranks first. `--limit`, `--format json` (`schemas/docs.json`).
  Rows: `tests/docs.test.ts`.

- **DX-29** MCP `searchDocs {query, limit?}`: `vx docs`'s JSON answer,
  so an agent on MCP finds the reference offline too. A query that
  would read as a flag is refused before the CLI sees it. Rows:
  `vx-mcp/tests/search-docs.test.ts`.
- **DX-30** the migrate guide says the first run after `vx-migrate` misses
  every task once (agent trial row 4): migrate declares the lockfile
  plugin and installs it, and `vx why` names both as the changed key
  parts; the example hits at once only because it keeps its own
  workspace file and installs nothing.
- **DX-31** error codes lead to fixes: each core code is its own
  `#### \`VX_E_…\``section of cli.md saying what to do, the`--format json`refusal carries its URL as`docs`(MCP passes it on),
and`vx docs <code>`prints that section alone. Rows:`tests/error-codes.test.ts`(a section per code the source throws, both
directions; the link;`vx docs VX_E_USAGE` alone).
- **DX-32** `vx init`'s `next:` line pins what it installs to the running
  vx's version (`@vzn/vx-migrate@0.0.633`): agent trial 2 got `latest`
  beside an older vx. Row: `tests/init.test.ts` (the next step).
- **DX-33** `vx run --affected --dry=json` states `affectedBase`, the ref
  the diff was taken against: trial 2's bare `--affected` guessed
  `HEAD~1`, whose commit edited the root `package.json`, and a reason
  with no file read as wrong. Rows: `tests/affected-dry-reasons.test.ts`.
- **DX-34** vx-migrate: a package whose `tsconfig.json` is a composite
  project (or sets `rootDir`) and takes in its config declares the preset
  values it uses instead of importing the root `vx-preset`: withastro/astro's
  `scripts/` build failed on that import (TS6059, TS6307; Growth, 0.0.633).
  Rows: `vx-migrate/tests/migrate-turbo-sealed-tsconfig.test.ts`.
- **DX-35** vx-migrate's preset inlining (DX-34) asks every `tsconfig*.json`
  from the config's directory up to the root, `include` / `exclude` /
  `files` and `${configDir}` as `extends` resolves them: astro's
  `packages/astro/tsconfig.test.json` takes in the nested
  `performance/vx.config.mjs`, and 0.0.634 still failed there (Engineering).
  astro dry run: 564 preset imports before, 562 after; `performance/` and
  `scripts/` declare the values. Rows: `migrate-turbo-sealed-tsconfig.test.ts`.
- **DX-36** Trial-2 lows: `affected.kind` gets its own `cli.md` heading
  so `vx docs affected kind input` returns it first (it was buried in
  "Planning mode"); `--graph` gets one too. `why.json` now says `cached`
  means "declares a cache", as `last.json` already did. Left as is: a
  rename of `cached` (breaks the JSON contract for a wording issue) and
  one JSON indentation across verbs (mixed already; compact saves tokens).
- **DX-37** Trial-2 row 9: `getFailures` and `vx last --failed --format
json` replayed a failure already fixed with no word of it. A failed
  task now carries `fixedIn`, the first later run where it passed (ran
  or hit). Rows: `run-output.test.ts` (another task passing is no fix),
  vx-mcp `tools.test.ts`, `cli-json-schemas.test.ts`.
