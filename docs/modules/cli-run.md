# `src/cli/run.ts` — `vx run` parser + handler

## Purpose

Parse `vx run`'s argv, resolve project scope (cwd / `--all` / `--filter`
/ `--affected` / picker), and invoke the orchestrator. Handles
both real runs (`orchestrator.run`) and planning paths (`planRun` →
text/json/DOT formatters).

## Public surface

```ts
export interface RunArgs {
  tasks: string[] // bare + `pkg#task` positionals
  filters: string[] // raw --filter values
  all: boolean
  excludeDependencies: 'all' | string[]
  concurrency: number | undefined
  noCache: boolean
  forwardArgs: string[] // everything after `--`
  verbosity: number
  dry: 'text' | 'json' | undefined
  graph: string | undefined // '' = stdout; else path
  summarize: string | undefined // '' = default path; else path
  profile: string | undefined // 'profile.json' default
  affected: string | undefined // '' = default base; else ref
  error?: string // parser-error message
}

export function parseRunArgs(args: readonly string[]): RunArgs
export async function runCmd(args: readonly string[]): Promise<number>

/**
 * Shared with `cli/watch.ts`: turn parsed args + cwd + task list into
 * the orchestrator's `RunOptions`. Returns either the options or an
 * error message (caller prefixes with subcommand name). Doesn't
 * handle the interactive picker — `runCmd` does that first, then
 * passes the resolved task list in.
 */
export async function resolveRunOptions(
  parsed: RunArgs,
  cwd: string,
  tasks: readonly string[],
): Promise<RunOptions | { error: string }>
```

## Parser

`parseRunArgs(argv)` walks the array once:

1. Split on the first `--` — everything after is `forwardArgs`.
2. Loop the prefix: recognize each flag form. Optional-value flags
   (`--dry`, `--graph`, `--summarize`, `--profile`, `--affected`,
   `--excludeDependencies`) accept either the bare form or `=<value>`.
3. Unknown flags + missing values + invalid integers → returned via
   `RunArgs.error`. The handler short-circuits to exit 1.
4. Mutually-exclusive combinations checked at the end:
   `--dry` + `--graph`; either + `--summarize` / `--profile`.

## Scope resolution

After parsing, `runCmd` builds the orchestrator's `projects` field:

| Condition                                  | `projects`                       |
| ------------------------------------------ | -------------------------------- |
| Every positional is anchored (`pkg#task`)  | `undefined` (no scope needed)    |
| Any bare positional + `filters.length > 0` | `resolveFilters(...)` result     |
| Any bare positional + `--all`              | `undefined` (every project)      |
| Any bare positional + default              | `[findCwdProject(cwd)]` or error |

`--affected[=<base>]` is sugar for an extra `[<base>]` filter
appended to `filterStrings` before `resolveFilters` runs.
`defaultAffectedBase(root)` resolves the no-value form
(`origin/HEAD` → fall back `HEAD~1`).

## Interactive picker

When `tasks.length === 0`:

- Non-TTY → exits 1 with `missing task name (stdin is not a TTY)`.
- TTY → `pickTask(cwd)` loads every project's tasks, prints a numbered
  list with `description` next to each id, reads a 1-based index via
  `readline/promises`, emits one anchored `pkg#task` into `tasks`.

## Planning short-circuit

If `--dry` or `--graph` is set:

1. `planRun(opts)` — same setup as `run` but stops before the
   scheduler.
2. Pick a formatter from `cli/plan-format.ts`:
   - `--dry=json` → `formatPlanJson(plan)` → stdout.
   - `--dry=text` (default) → `formatPlanText(plan)` → stdout.
   - `--graph=''` → `formatGraphDot(plan)` → stdout.
   - `--graph=<path>` → `formatGraphDot(plan)` → `Bun.write(path, ...)`.
3. Empty plan → exits 1 with `no projects declare task(s): …`.

## Verbose summary

`--verbosity 1` prints a per-task table after the framed blocks:

```
TASK              STATUS        DURATION
-----------------------------------------------
@vzn/vx#lint      cache         4ms
@vzn/vx#test      ok            5200ms
```

Columns auto-width to the widest row. `--verbosity 2+` is reserved.

## Tests

`tests/cli.test.ts` is the main coverage:

- All flags: presence, value-or-not forms, missing-value errors,
  unknown-flag errors.
- Scope resolution matrix (default / `--all` / `--filter` /
  `pkg#task`).
- Interactive picker (TTY input mocked).
- `--affected` end-to-end against a git fixture.
- Planning paths (`--dry` text/json, `--graph` stdout/file).
- Verbose summary formatting.
- `--summarize` and `--profile` artifact emission.
- Forwarded args (cache-key folding tested in
  `tests/orchestrator.test.ts`).

## Replacing this module

The internal seam is small: `runCmd(argv): Promise<number>`. Replace
the body but keep that contract — `cli.ts` dispatches to it by
import. To swap the picker (e.g. for a fuzzy selector), replace
`pickTask` in-place; nothing else depends on it.
