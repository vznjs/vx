# @vzn/vx-conformance

One suite of task-runner behaviours, run against **vx**, **Turborepo**, **Nx**
and **Vite Task**. Each case is a small workspace and the outcome a user
sees: which commands ran, the files left on disk, the exit code, and the
data the tool reports about the run. The results (every case, what each
tool did, each tool's score) are the site's conformance page, written to
`private/vx-docs/src/data/conformance.json`.

```sh
bun src/cli.ts                    # every case, every tool → the site's data
bun src/cli.ts --tool nx --case outputs/ --verbose
```

## A case

A case speaks no tool's language. Its workspace names projects, their
dependencies and their tasks: a `sh` command, `dependsOn` (`^build`,
`build`, `lib#build`), `inputs` and `outputs` as project-relative globs,
root-level ones, `env` names, `runtime` commands, `cache: false`,
`timeout`, `retries`, `persistent`. Its steps write, delete, chmod and
link files, run `sh`, install, commit, change the config, check the tree,
and run a task (or several): in some projects, by selectors, from a directory, with
args, a concurrency limit, or a signal sent mid-run. Each run says what
must hold:

| Field        | Holds when                                             |
| ------------ | ------------------------------------------------------ |
| `exit`       | the run succeeds (`0`) or fails (`'fail'`)             |
| `ran`        | each task named ran its command                        |
| `notRan`     | each task named did not: it was replayed or left out   |
| `order`      | `[a, b]`: a's command finished before b's started      |
| `files`      | each file holds exactly this text, or (`null`) is gone |
| `filesNot`   | each file does not hold this stale text                |
| `ifReplayed` | a task that did not run left these files               |
| `output`     | the run's output holds this text                       |
| `report`     | the tool reports this about a task's run               |
| `orRefused`  | a run refused before any task starts also passes       |
| `within`     | the run ends within this many seconds                  |
| `alone`      | no process the run started outlives it                 |

Every run also fails a tool that starts one task twice. The harness puts a
mark before and after each command, so "ran" means the command ran, not
what a tool's log claims.

A case is `correctness` when failing it leaves a wrong tree or exit code,
`efficiency` when failing it reruns work nothing asked for, and `data`
when it is about what the tool reports of a run: cache status, time, CPU,
memory, output size, read from its output, files or API. How a log reads
is not measured. Every case has a `why`: 3–4 sentences on why the
outcome is right and what the alternative costs a user, shown collapsed
under the case on the site. `from`
names the vx tests the case is drawn from. `needs` names a feature a
tool may lack (affected, timeout, retries, persistent tasks…); a tool
without it scores the case not applicable.

## Adapters

An adapter writes the tool's own config from the neutral workspace and
maps a run to its CLI, and reads what the tool reports about a run from
the richest place the tool offers. It decides nothing. Where a tool needs an idiom to
mean the same thing, the adapter uses the one its docs teach:

- **Turborepo**: a package.json script per task, a `project#task` entry
  in turbo.json each. Runs pass `--summarize`; the report is its run summary.
- **Nx**: an `nx:run-commands` target per task; each task's inputs are a
  named input, and each `^task` in `dependsOn` adds the dependency's own
  (`^build-inputs`, Nx's `^production` idiom). The report is the cache's
  `run.json`.
- **Vite Task**: `run.tasks` in each project's vite.config.ts. It selects
  by package only and runs one task per run, so `affected` and several-task
  cases are not applicable to it. The report
  is `vp run --last-details`.
- **vx**: a vx.config.mjs per project, `bun()` for the edges, `vx lock`.
  The report is `vx last --format json`.

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
