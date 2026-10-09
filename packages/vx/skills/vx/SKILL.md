---
name: vx
description: Run, inspect and debug tasks in a vx monorepo (vx.config.ts, vx.workspace.ts). Use to build or test projects, find what a change affects, read why a task failed or re-ran, and query the cache as JSON.
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
vx run build --all --format json    # the result as JSON on stdout; logs go to stderr
```

The exit code is the verdict: `0` every task passed or hit the cache, `1` a
task failed or was skipped, or the command was refused. `--format json`
prints `schemas/summary.json` (`runId`, `ok`, `exitCode`, a row per task).
Without a TTY a missing task name never prompts: vx exits 1 and lists the
tasks it found.

## Look before running

```sh
vx show --format json                          # projects, their tasks and dependencies
vx run test --affected=origin/main --dry=json  # what would run, cache hit or miss, and why
```

Under `--affected`, each kept task in `--dry=json` carries `affected`:
`{ kind, file?, project?, via? }`, where `kind` is `input` (a changed file
is one of its inputs), `project`, `package`, `named` or `selected`, and
`via` is the `dependsOn` chain that carried the change.

## When a task fails

```sh
vx last --failed --format json   # the last failed run; a failed row has output and locations
vx last --log app#build          # one task's output: a failure's, or its cached log
```

A failed row's `output` is the task's output as plain text (secrets masked)
and `locations` the files it names as `{ file, line?, col? }`. Read those
files, fix, and re-run the same command: cached tasks that passed replay from the cache.

## When a task re-ran unexpectedly

```sh
vx why app#build --format json   # which input changed, down to the root cause
```

## Workspace health

```sh
vx info --format json   # vx and Bun versions, projects, config errors, plugins, cache
```

## MCP

When `@vzn/vx-mcp` is a plugin in `vx.workspace.ts`, `vx mcp` serves the
same facts and runs tasks. Adoption does not add it: install
`@vzn/vx-mcp` and put `mcp()` (from `'@vzn/vx-mcp'`) in `plugins`. Its tools: `listTasks`, `getCacheStats`,
`getRunHistory`, `explainCacheKey`, `whyDidThisRerun`, `getFailures`, `getTaskLog`, `getConfig`, `checkLock`, `pruneCache`, `planInit`, `searchDocs`,
`getWorkspaceInfo`, `runTasks`, `planTasks`. `runTasks` answers what
`vx run <tasks> --format json` prints, `planTasks` what
`vx run <tasks> --dry=json` prints, `pruneCache` evicts only with
`dryRun: false`; the others only read.

## Rules

- Never delete or edit the cache by hand; vx repairs it itself.
- A sandboxed task that fails on a denied path: grant that one path in
  `exec.sandbox.allow`. Never remove `sandbox` or widen it further.
- A cached task declares its inputs (`cache.inputs.files`); if a change
  does not re-run a task, the file is not one of its inputs. Fix the
  config, do not force.
- Every JSON shape is a JSON Schema in `node_modules/@vzn/vx/schemas/`.
- Offline reference: `vx docs <words> --format json` searches the CLI, config
  and cache pages that ship with vx; the sections holding every word print
  whole.
- Docs as markdown: https://vznjs.github.io/vx/llms.txt (its index).
  When that host is unreachable, the same pages are
  `https://raw.githubusercontent.com/vznjs/vx/main/packages/vx-docs/src/content/docs/<page>.md`:
  `quickstart`, `guides/migrate`, `guides/configure`, `guides/agents`,
  `guides/troubleshooting`, `guides/ci`, `guides/plugins`.
