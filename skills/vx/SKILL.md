---
name: vx
description: Run, inspect and debug tasks in a vx monorepo (vx.config.ts, .vx/workspace.ts). Use to build or test projects, find what a change affects, read why a task failed or re-ran, and query the cache as JSON.
---

# vx

vx is the workspace's task runner and build cache. Run tasks through it, not
through package scripts, so results are cached and ordered by their
dependencies.

## Run

```sh
vx run build --all                  # a task in every project that declares it
vx run test --affected=origin/main  # only what the diff since origin/main reaches
vx run app#build                    # one project's task (and what it depends on)
vx last --format json               # the last run's result as JSON
```

The exit code is the verdict: `0` every task passed or hit the cache, `1` a
task failed or was skipped, or the command was refused. `vx last --format
json` prints the run as JSON afterwards, a row per task. A refusal under
`--format json` (or `--dry=json`) is one line on stdout,
`{"ok":false,"error":{"code","message","docs"}}`: branch on `code`;
`docs` (or `vx docs <code>`) says what to do.
Without a TTY a missing task name never prompts: vx exits 1 and lists the
tasks it found.

## After editing a config

```sh
vx lock   # after any edit to a vx.config.ts or .vx/workspace.ts
```

A run reads every config from `.vx/projects.lock.json`, never the files:
a task you add, or an edit to one, does nothing until `vx lock`. Commit
the lock with the config.

## Look before running

```sh
vx show --format json                          # projects and their tasks
vx show app --format json                      # one project's tasks as a run reads them
vx run test --affected=origin/main --dry=json  # what would run, cache hit or miss, and why
```

Under `--affected`, `--dry=json` states `affectedBase` (the ref it diffed
against; name one, `--affected=origin/main`, rather than trust the guess)
and each task you asked for carries `affected` (a dependency it pulls in
does not):
`{ kind, file?, project?, via? }`, where `kind` is `input` (a changed file
is one of its inputs), `project`, `package`, `named` or `selected`, and
`via` is the `dependsOn` chain that carried the change.

## When a task fails

```sh
vx last --failed --format json   # the last failed run; a failed row has output and locations
vx last --log app#build          # one task's output: a failure's, or its cached log
```

`warnings` holds what the run warned of (absent when nothing).
A failed row's `output` is the task's output as plain text (secrets masked)
and `locations` the files it names as `{ file, line?, col? }`. Read those
files, fix, and re-run the same command: cached tasks that passed replay from the cache.

## When a task re-ran unexpectedly

```sh
vx why app#build --format json   # which input changed, down to the root cause
```

## Run history

```sh
vx last --stats --format json            # per task: p50 (the live estimate's), p99, pass and hit rate, failure mode, peak RSS
vx last --stats --branch main --format json  # p50 from main's timings
vx last --stats app#build --format json  # one task; a task name covers every project
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
- Every JSON shape is a JSON Schema in `node_modules/@vzn/vx/schemas/`.
- Reference: `vx docs <words> --format json` searches the reference pages at
  this vx's release tag on GitHub (online); the sections holding every word
  print whole.
- Docs as markdown: https://vznjs.github.io/vx/llms.txt (its index).
  When that host is unreachable, the same pages are
  `https://raw.githubusercontent.com/vznjs/vx/main/private/vx-docs/src/content/docs/<page>.md`:
  `quickstart`, `guides/migrate`, `guides/configure`, `guides/agents`,
  `guides/troubleshooting`, `guides/ci`, `guides/plugins`.

## Install

`bunx skills add vznjs/vx` installs this skill. To match the vx a workspace
has installed, copy it from there instead:
`cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/`.
`vx upgrade` inside a workspace moves the project's `@vzn/vx` and the
global vx that ran it to the same version, then runs `vx lock`.
