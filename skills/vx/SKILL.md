---
name: vx
description: Run, inspect and debug tasks in a vx workspace (vx.config.ts, .vx/workspace.ts). Use to build or test projects, find what a change affects, read why a task failed or re-ran, and query the cache as JSON.
---

# vx

vx is the workspace's task orchestrator and build cache. Run tasks through it, not
through package scripts, so results are cached and ordered by their
dependencies.

Call `vx` (on PATH after `vx init`), or `bun vx` in a script or CI job.
Never run it through bunx or npx: the npm package named `vx` is another tool.

A project's name is its `package.json` `name`: `vx run @acme/app#build`,
not `app#build`. `vx show --format json` lists the names.

## Run

```sh
vx run build --all                  # a task in every project that declares it
vx run test --affected=origin/main  # only what the diff since origin/main reaches
vx run @acme/app#build              # one project's task (and what it depends on)
vx run test --all --fail-fast       # stop at the first failure, killing running tasks
vx pipeline pr                      # a named run saved in .vx/workspace.ts (what CI runs)
vx last --format json               # the last run's result as JSON
```

The exit code is the verdict: `0` every task passed or hit the cache, `1` a
task failed or was skipped, or the command was refused. `vx last --format
json` prints the run as JSON afterwards, a row per task. A refusal under
`--format json` is one line on stdout,
`{"ok":false,"error":{"code","message","docs"}}`: branch on `code`;
`docs` (or `vx docs <code>`) says what to do.
Without a TTY a missing task name never prompts: vx exits 1 and lists the
tasks it found.

## After editing a config

```sh
vx lock   # after any edit to a vx.config.ts or .vx/workspace.ts
```

A run reads every config from `.vx/projects.lock`, never the files:
a task you add, or an edit to one, does nothing until `vx lock`, and a
run after an edit refuses with `<file> changed since the last vx lock`.
Commit the lock with the config. After a merge conflict in
`.vx/projects.lock`, resolve the configs and run `vx lock`; never edit a
lock by hand. A new package needs `bun install` (or your package
manager's install), then `vx lock`.

One forwarded argument list reaches one task:
`vx run @acme/lib#test -- -t greet`.

## Look before running

```sh
vx show --format json                          # projects and their tasks
vx show @acme/app --format json                # one project's tasks as a run reads them
vx run test --affected=origin/main --dry --format json  # what would run, cache hit or miss, and why
```

Under `--affected`, `--dry --format json` states `affectedBase` (the ref it diffed
against; name one, `--affected=origin/main`, rather than trust the guess)
and each task you asked for carries `affected` (a dependency it pulls in
does not):
`{ kind, file?, project?, via? }`, where `kind` is `input` (a changed file
is one of its inputs, or its definition), `always` (a command with no
inputs), `project`, `workspace`, `package`, `named` or `selected`, and
`via` is the `dependsOn` chain that carried the change. A change no input
declares reaches no task; declare `inputs` on a task so it runs only when
they change.

## While a run is in progress

```sh
vx last --live --format json            # what runs, what ended, what waits, warnings so far
vx last --live --follow --format json   # then each event (output included), one per line, until the run ends
```

## When a task fails

```sh
vx last --failed --format json   # the last failed run; a failed row has output and locations
vx last --log @acme/app#build    # one task's output: a failure's, or its cached log
```

`warnings` holds what the run warned of (absent when nothing).
A failed row's `output` is the task's output as plain text (secrets masked),
`locations` the files it names as `{ file, line?, col? }`, and `dir` its
project's directory: a relative path in the output starts there. Unless
the run asked for a single task, a failed command's `$` line in its output
names that directory too. Read those
files, fix, and re-run the same command: cached tasks that passed replay from the cache.

## When a task re-ran unexpectedly

```sh
vx why @acme/app#build --format json  # which input changed, down to the root cause
```

## Run history

```sh
vx last --stats --format json            # per task: p50 (the live estimate's), p99, pass and hit rate, failure mode, peak RSS
vx last --stats --branch main --format json  # p50 from main's timings
vx last --stats @acme/app#build --format json  # one task; a task name covers every project
vx last --list --format json             # recent runs, newest first
vx last --sql "SELECT name, sql FROM sqlite_schema" --format json  # the history's tables
```

Any other question (one task's memory trend, failures per project, which
inputs a key folded) is one read-only query: `vx last --sql "<SELECT>"
--format json` prints `{ rows }`. `runs` holds one row per task per run
(duration, cache hit, cpu, memory, attempts, failure reasons),
`invocations` one per run; join on `run_id`. Times are epoch ms.

## Workspace health

```sh
vx info --format json        # vx and Bun versions, projects, plugins, cache
vx lock --check --format json  # a vx.config that changed since the lock, or no longer loads
```

## Rules

- Never delete or edit the cache by hand; vx repairs it itself.
- A sandboxed task that fails on a denied path: grant that one path in
  `exec.sandbox.allow`. Never remove `sandbox` or widen it further.
- A task declares its inputs (`inputs.files`), cached or not; if a
  change does not re-run a task, the file is not one of its inputs. Fix
  the config, do not force. A task with no `inputs` has no key, so every
  cached task behind it misses: give it `inputs`.
- Every `outputs.files` path (`dist/index.js`, `dist`) must exist after
  the task, and at least one output must match, or it fails (`outputs
matched no files`); a wildcard (`dist/**`) may match nothing beside one
  that matched. Fix the pattern or the command.
- A task that imports a workspace dependency's built files (a test of
  `@acme/app` importing `@acme/lib`'s `dist/`) needs
  `dependsOn: ['^build']`, or it reads a stale or missing build.
- Setting up CI, a remote cache, distributed task execution or a
  migration: read its docs page first (below), then follow it. On CI,
  run `bun vx pipeline <name>` with the `github()` plugin (`docs/ci`).
  Never cache `.vx/cache` with `actions/cache`: the local cache lives in
  `~/.vx`; machines share one through a remote cache plugin
  (`docs/remote-cache`).
- Every JSON shape is a JSON Schema in `node_modules/@vzn/vx/schemas/`.
- Reference: `vx docs <words> --format json` searches the reference pages at
  this vx's release tag on GitHub (online); the sections holding every word
  print whole.
- Docs as markdown: https://vznjs.github.io/vx/llms.txt (its index).
  When that host is unreachable, the same pages are
  `https://raw.githubusercontent.com/vznjs/vx/main/private/vx-docs/src/content/docs/<page>.mdx`:
  `quickstart`, `docs/tasks`, `docs/caching`, `docs/workspace`,
  `docs/sandboxing`, `docs/ci`, `docs/remote-cache`, `docs/migrate`,
  `docs/running-tasks`, `docs/plugins`, `docs/agents`.

## Install

`bunx skills add vznjs/vx` installs this skill. To match the vx a workspace
has installed, copy it from there instead:
`mkdir -p .claude/skills/vx && cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/`.
`vx upgrade` inside a workspace moves the project's `@vzn/vx` and the
global vx that ran it to the same version, then runs `vx lock`.
