# @vzn/vx-conformance

One suite of task-runner behaviours, run against **vx**, **Turborepo**, **Nx**,
**Vite Task** and **Nix**. Each case is a small workspace and the outcome a user
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
root-level ones, `env` names (keyed), `passThrough` names (not keyed),
`runtime` commands, `cache: false`, `timeout`, `retries`, `persistent`,
`dependencyInputs: false`, and `sandbox` (the task may read only its
inputs, write only its outputs, and reach no network, beyond what it is
granted). A workspace may also hold `outside` files: a directory beside
the repository (`../outside`), as a `file:` or `link:` dependency there
is. Its steps write, delete, chmod and
link files, run `sh`, install, commit, change the config, check the tree,
and run a task (or several): in some projects, by selectors, from a directory, with
args, a concurrency limit, a signal sent mid-run (and again, as a second
Ctrl-C), its stdin held open as an idle terminal, going on past a failure,
forced past the cache, reading the cache without writing it, or planned
without running; or watch a task. Each run says what must hold:

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

A watch step starts the tool's watch mode and plays phases under it: a
change (files written or deleted, a `sh` command, a config edit), then
`ran`, `notRan`, `order`, `files` or `filesNot` as above. The first phase,
with no change, is the initial run. A phase is judged once what it expects
holds and no task has started or ended for 8 s, so a late rerun or a loop
on the task's own output lands inside it; `inFlight` judges at once, to
make the next change mid-run. Then the watch gets SIGINT, and a watch
still running 10 s later is killed with its sandbox.

Every run also fails a tool that starts one task twice. The harness puts a
mark before and after each command, so "ran" means the command ran, not
what a tool's log claims.

The `sandbox` category is isolation: an undeclared variable, file read,
file write, credential store or network connection a task cannot reach.
A tool that cannot isolate a task scores those cases not applicable,
except the variable case, which needs no isolation feature to pass.

A case is `correctness` when failing it leaves a wrong tree or exit code,
`efficiency` when failing it reruns work nothing asked for, and `data`
when it is about what the tool reports of a run: cache status, time, CPU,
memory, output size, read from its output, files or API. How a log reads
is not measured. Every case has a `why`: 3–4 sentences on why the
outcome is right and what the alternative costs a user, shown collapsed
under the case on the site. `from`
names the vx tests the case is drawn from. `needs` names a feature a
tool may lack (affected, timeout, retries, persistent tasks, watch…); a tool
without it scores the case not applicable.

## Adapters

An adapter writes the tool's own config from the neutral workspace and
maps a run to its CLI, and reads what the tool reports about a run from
the richest place the tool offers. It decides nothing. Where a tool needs an idiom to
mean the same thing, the adapter uses the one its docs teach:

- **Turborepo**: a package.json script per task, a `project#task` entry
  in turbo.json each. Runs pass `--summarize`; the report is its run summary.
  Watch is `turbo watch`.
- **Nx**: an `nx:run-commands` target per task; each task's inputs are a
  named input, and each `^task` in `dependsOn` adds the dependency's own
  (`^build-inputs`, Nx's `^production` idiom). The report is the cache's
  `run.json`. Watch is `nx watch --all --initialRun -- nx run-many -t
<task>`, with the daemon it needs on.
- **Vite Task**: `run.tasks` in each project's vite.config.ts. It selects
  by package only, runs one task per run and has no watch mode, so
  `affected`, several-task and watch cases are not applicable to it. The report
  is `vp run --last-details`.
- **Nix**: a `default.nix` at the root, a raw `derivation` per task (no
  nixpkgs), run by `nix-build` (`src/adapters/nix-run.ts`). Declared
  inputs are the derivation's sources, each glob a regex matched in Nix at
  every evaluation; omitted inputs are the project's git-tracked files, as
  a flake sees them. `dependsOn` are derivation inputs, whose outputs the
  build sees at their workspace paths; `env` names are `builtins.getEnv`
  attributes; a `cache: false` task takes a per-run nonce. The build runs
  in a copy of the workspace; its declared outputs, or with none declared
  what its command wrote, go to `$out`, and the run copies each built
  task's `$out` back into the tree: the Nix store is the cache. The report
  is the derivations nix-build lists to build. Each case has its own store
  in its home, so the builds run unsandboxed and without build users. It
  lacks affected, every selector but a project list, task patterns,
  persistent tasks, timeouts, retries, runtime inputs, pass-through
  variables, dependency inputs off, continue, force, read-only cache,
  isolation and watch. It needs Nix on the PATH (`nix-build`,
  `nix-instantiate`); its version is `nix --version`.
- **vx**: a vx.config.mjs per project, `bun()` for the edges, `vx lock`,
  and its default cache store (in the case's home, so a linked worktree
  shares it). An isolated task is `exec.sandbox`. The report is
  `vx last --format json`. Watch is `vx watch`.

## Sandbox

Every command a tool runs goes through bubblewrap: the filesystem
read-only except the case's directory, no network, a fresh home inside
the case, and its own PID namespace, so a daemon dies with the run. No
case can read another's cache or reach a remote one. Without `bwrap` the
suite refuses to run. A case that needs `sandbox` keeps the host's `/proc`
and PID namespace, as a tool's own bwrap cannot mount a proc inside a
fresh one and reads its own PIDs there.

## Coverage

[src/inventory.ts](src/inventory.ts) sorts every test file in the repo:
`pending` (an outcome a case can carry, not yet written), `vx-only`,
`internal`, `docs`. A file a case cites counts as carried.
`tests/inventory.test.ts` fails when a test file is in no list.
