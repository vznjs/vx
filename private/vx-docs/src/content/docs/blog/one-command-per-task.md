---
title: 'One command per task; the shell is the API'
date: 2026-09-10T23:43:00Z
authors:
  - vzn
tags:
  - design
  - execution
excerpt: "A vx task is one shell command. Not a JavaScript function, not an executor with an options object, not a list of steps. The constraint is what makes remote execution, sandboxing, replay and migration all fall out for free."
---

A task is one string:

```ts
color: {
  exec: { command: "printf 'step 1\\rstep 2\\rdone\\n'" },
  inputs: { files: [] },
  cache: { outputs: { files: [] } },
}
```

Run it twice, the second time from the cache, and compare the bytes:

```sh frame="terminal"
$ vx run packages/d#color | sed -n 3p | od -c     # miss: ran
0000000   s   t   e   p       1  \r   s   t   e   p       2  \r   d   o
0000020   n   e  \n
$ vx run packages/d#color | sed -n 3p | od -c     # hit: replayed
0000000   s   t   e   p       1  \r   s   t   e   p       2  \r   d   o
0000020   n   e  \n
```

Same bytes, carriage returns included. A hit looks like the run. Demo
workspace, vx at `69617eb`, 2026-10-23.

`exec.command` runs under `sh -c`, in the project's directory, with the
project's and the workspace root's `node_modules/.bin` on `PATH` and
the environment you declared. That is the whole execution model.

## What it rules out

| Not in vx                    | Why                                                                 |
| ---------------------------- | ------------------------------------------------------------------- |
| JavaScript-function tasks    | can't ship to a worker, be sandboxed or replayed; inputs are a closure |
| executor plugins             | a wrapper between you and the tool's own flags and docs             |
| step lists                   | three behaviours under one key: use `&&`, or split with `dependsOn` |

A plugin changes *where* a command runs, never what it is.

## What it makes possible

Every capability is a transformation of one triple: command, declared
inputs, declared outputs.

- **Remote execution** ships it as one REAPI action.
- **The sandbox** wraps one process in `bwrap` or seatbelt with the
  declared paths.
- **Replay** stores the captured stdout in the cache index and prints it
  byte-identical on a hit, NUL bytes, carriage returns and raw ANSI
  included.
- **Migration** from Turborepo or Nx is mostly rendering: both run a
  command in the end.
- **`vx show` and `--dry`** print what a person would type.

## The environment is declared too

A command's environment is part of what it does, so it is not
inherited wholesale. Each task gets an isolated environment: a small
essential allowlist (`PATH`, `HOME`, `CI`, `NODE_OPTIONS` and a few
more), then what `exec.env` says: values you set (part of the config, so in the key) and
variables you `passThrough` from the parent (not in the key).
`inputs.env` puts a variable in the key but does not pass it to
the task, so a variable that changes the output and must reach the
task goes in both. `PATH` is prepended
with the project's `node_modules/.bin`, then the workspace root's, so
`tsc` resolves by name. A variable that changes the output and
is missing from `inputs.env` is the most common
under-declaration, and it shows up as a stale hit: the key did not
change, so vx replays the old output.

Two variables are always set: the workspace vx is running and the task
id, so a command that runs `vx` itself against the same workspace is
refused instead of recursing into the same cache.

## The API is the one you already have

vx needs no plugin for a tool. There is no `@vzn/vx-vite` or
`@vzn/vx-jest`, because `vite build` and `jest` are already the API.
Tool knowledge belongs in presets, in TypeScript, on top of a runner
that only knows what a command is.

Reference: [CI and remote › Run and filter](../../guides/ci/#run-and-filter) and
[Configure › Environment variables](../../guides/configure/#environment-variables).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
