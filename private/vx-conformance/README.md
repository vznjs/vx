# @vzn/vx-conformance

One suite of task-runner behaviours, run against **vx**, **Turborepo**, **Nx**
and **Vite Task**. Each case is a small workspace and the outcome a user
sees: which commands ran, the files left on disk, the exit code. The score
per tool and category, and every case where the tools differ, are in
[report/REPORT.md](report/REPORT.md).

```sh
bun src/cli.ts                    # every case, every tool → report/
bun src/cli.ts --tool nx --case outputs/ --verbose
bun src/cli.ts --check vx         # vx against the committed report (CI)
```

## A case

A case speaks no tool's language. Its workspace names projects, their
dependencies and their tasks: a `sh` command, `dependsOn` (`^build`,
`build`, `lib#build`), `inputs` and `outputs` as project-relative globs,
`env` names, `cache: false`. Its steps write files, commit, change the
config, and run a task; each run says what must hold:

| Field    | Holds when                                             |
| -------- | ------------------------------------------------------ |
| `exit`   | the run succeeds (`0`) or fails (`'fail'`)             |
| `ran`    | each task named ran its command                        |
| `notRan` | each task named did not: it was replayed or left out   |
| `order`  | `[a, b]`: a's command finished before b's started      |
| `files`  | each file holds exactly this text, or (`null`) is gone |
| `output` | the run's output holds this text                       |

Every run also fails a tool that starts one task twice. The harness puts a
mark before and after each command, so "ran" means the command ran, not
what a tool's log claims.

A case is `correctness` when failing it leaves a wrong tree or exit code,
`efficiency` when failing it reruns work nothing asked for, and `output`
when it is only about what the run prints: a log is never correctness. `why` says
why the outcome is right where a tool could argue for another. `from`
names the vx tests the case is drawn from.

## Adapters

An adapter writes the tool's own config from the neutral workspace and
maps a run to its CLI. It decides nothing. Where a tool needs an idiom to
mean the same thing, the adapter uses the one its docs teach:

- **Turborepo**: a package.json script per task, a `project#task` entry
  in turbo.json each.
- **Nx**: an `nx:run-commands` target per task; each task's inputs are a
  named input, and each `^task` in `dependsOn` adds the dependency's own
  (`^build-inputs`, Nx's `^production` idiom).
- **Vite Task**: `run.tasks` in each project's vite.config.ts. It selects
  by package only, so `affected` cases are not applicable to it.
- **vx**: a vx.config.mjs per project, `bun()` for the edges, `vx lock`.

## Sandbox

Every command a tool runs goes through bubblewrap: the filesystem
read-only except the case's directory, no network, a fresh home inside
the case, and its own PID namespace, so a daemon dies with the run. No
case can read another's cache or reach a remote one. Without `bwrap` the
suite refuses to run.

## Coverage

[src/inventory.ts](src/inventory.ts) sorts every test file in the repo:
`pending` (an outcome a case can carry, not yet written), `vx-only`,
`internal`, `docs`. A file a case cites counts as carried.
`tests/inventory.test.ts` fails when a test file is in no list.
