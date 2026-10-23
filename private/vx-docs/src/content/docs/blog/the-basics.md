---
title: 'The basics, done carefully'
date: 2026-10-09T10:20:00Z
authors:
  - vzn
tags:
  - dx
  - ci
excerpt: 'vx run picks the project you stand in. Off a terminal it never waits on a picker. On GitHub Actions every task folds into its own log group. Plus colors that respect FORCE_COLOR=0, and a build edge for packages that ship as source.'
---

```sh frame="terminal"
$ cd packages/a && vx run build     # the project you stand in
┌─ packages/a#build > $ bun build src/index.ts --outdir dist
Bundled 1 module in 3ms

$ vx run | cat                      # a pipe: no picker
✗ vx run  missing task name (stdin is not a TTY, so no picker; tasks here: build, check, e2e, flip, notes, plain, slow, test)

  see vx run --help
```

Demo workspace, vx at `69617eb`, 2026-10-23. What a bare command does,
what happens in a pipe, how the CI log reads: small things, done
carefully.

## Run what you mean

```sh frame="terminal"
$ vx run build                      # the project you stand in
$ vx run build --all                # every project that declares build
$ vx run packages/c#test            # one task, from anywhere
$ vx run build test lint --all      # several at once, one graph
```

## No picker in a pipe

On a terminal, a bare `vx run` opens a picker. In a pipe, a script or an
agent's shell there is nobody to pick, so vx lists the tasks and exits
1, as above. Off a terminal the live progress region is gone too. The log gets plain
lines that read the same in a file.

## One fold per task on GitHub Actions

On Actions, each task's block is wrapped in a log group with its outcome
and time, so a long run collapses to one line per task:

```sh frame="terminal"
$ GITHUB_ACTIONS=true CI=true vx run build --filter packages/c --force
::group::packages/a#build (success 7ms)
::stop-commands::95fb31f4-10a0-4d85-8a5d-1a444d8bb4de
┌─ packages/a#build > success
$ bun build src/index.ts --outdir dist
├─ OUTPUT ──────────────────────────────────────────────────
Bundled 1 module in 3ms
  index.js  78 bytes  (entry point)
└─ packages/a#build ── (7ms) success
::95fb31f4-10a0-4d85-8a5d-1a444d8bb4de::
::endgroup::
```

A failed task stays open and adds an error annotation instead, such as
`failed (exit 137, 128 + SIGKILL)`. The `stop-commands` token fences
the task's own output, so a line it prints can never be read as a
workflow command.

## Colors that listen

Output is truecolor on a terminal and plain elsewhere. `NO_COLOR` turns
it off. `FORCE_COLOR` turns it on, except `FORCE_COLOR=0` and
`FORCE_COLOR=false`, which mean off, the way chalk and Node read them.

## Packages shipped as source

A package with no build step still matters to the packages that use it.
So a project that declares no `build` gets one: a group with
`dependsOn: ['^build']`, keyed on the project's files, that runs nothing.
Edit that package, and its dependents' keys change, so `--affected`
reaches them.

Every flag is in the [CLI reference](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
