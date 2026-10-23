---
title: 'vx lock: freezing what the key sees'
date: 2026-09-10T23:44:00Z
authors:
  - vzn
tags:
  - config
  - ci
excerpt: "Configs are programs, and programs can read the environment. `vx lock` evaluates every config once and writes what it got; every run reads that; `vx lock --check` catches drift a byte hash can't see."
---

A TypeScript config can depend on where it runs. This one does:

```ts
exec: { command: `bun build src/index.ts --outdir dist --minify=${process.env.MINIFY ?? 'false'}` },
```

Nothing in the file changes when `MINIFY` does. `vx lock --check`
still sees it:

```sh frame="terminal"
$ vx lock
✓ vx lock  4 project configs → .vx/projects.lock.json

$ vx lock --check
✓ vx lock --check  up to date (4 projects)

$ MINIFY=true vx lock --check
✗ vx lock --check  packages/d/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'
$ echo $?
1
```

## Two verbs

```bash
vx lock              # evaluate every vx.config.* now; write .vx/projects.lock.json
vx lock --check      # re-evaluate everything; exit 1 on any difference
```

`vx lock` is the only verb that evaluates a config or writes the lock.
It also checks the graph rules. Every `vx run`, every `vx watch` cycle,
every `--affected` selection reads configs only from the lock. With no
lock, a run stops:

```sh frame="terminal"
$ vx run build --all
✗ vx run  no lock: run `vx lock`
```

A project with no `vx.config.*`, whose tasks come from a plugin's
`project` stage such as `turbo()`, has nothing to lock and gets its
tasks live on every run.

## The check a hash can't do

`--check` evaluates every config again and compares the result to the
lock. It catches an edit, and also what an edit detector can't: an env
value read at evaluation time, a changed preset import, a computed
command whose input moved. On this repository (12 projects) it takes
170 ms (min of 10, linux x64, 2026-10-23).

The CI recipe is two commands:

```bash
vx lock --check && vx run ci --all
```

A pull request that changes a config without running `vx lock` fails
the first one. That is the point.

## What the lock is not

| Not…                           | Because                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| a cache key input              | `vx lock` must not re-key the workspace.                                |
| a substitute for `inputs.env`  | The lock freezes config-time values; run-time env belongs in the key.   |
| only about speed               | Every run uses the configs a reviewer saw.                              |

## For agents

`vx lock --check --format json` answers with the same exit code:

```json
{"upToDate":false,"audited":4,"notAudited":0,"problems":["packages/d/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'"]}
```

Package managers learned the same lesson with `--frozen-lockfile`:
resolve freely in development, pin where reproducibility is the
contract. Reference: [`vx lock`](../../cli/#vx-lock). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
