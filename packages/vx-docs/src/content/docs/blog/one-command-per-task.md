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

`exec.command` is a string. It runs under `sh -c` with the package's
`node_modules/.bin` on `PATH`, in the project's directory, with the
environment you declared. That is the entire execution model, and it
is a constraint chosen on purpose.

## What it rules out

**JavaScript-function tasks.** A task that is a function in the config
file is convenient right up to the moment you want to run it somewhere
else. It cannot be shipped to a worker, cannot be sandboxed at the OS
level, cannot be replayed from a log, and its inputs are whatever the
closure captured. vx has no `run: async () => …`, and will not.

**Executors.** Nx wraps tools behind plugins with options objects, so
`@nx/js:tsc` with `{ main, tsConfig }` is a layer between you and the
`tsc` documentation. When the tool adds a flag, the executor has to
learn it. When the executor has a bug, the tool did not. vx has no
executor plugins; a plugin changes *where* a command runs, never what
it is.

**Step lists.** A task that is `[build, then copy, then compress]` is
three tasks pretending to be one, with one cache key for three
behaviours. Chain with `&&` if the steps truly are one unit, or split
them into tasks wired by `dependsOn` so each caches independently.

## What it makes possible

Once a task is a command with declared inputs and outputs, every
capability in vx becomes a transformation of the same triple:

- **Remote execution** ships it as one REAPI action: the command
  string, the declared input tree, the declared output paths. Nothing
  about the task has to be serialisable beyond what it already is.
- **The sandbox** wraps the command in `bwrap` or seatbelt with the
  declared paths. There is exactly one process to confine.
- **Replay** stores the captured stdout in the cache row and prints it
  byte-identical on a hit, NUL bytes, carriage-return progress
  rewrites and raw ANSI included. A hit looks like the run.
- **Migration** from Turborepo or Nx is mostly a rendering problem,
  because both of them ultimately run a command too; vx just writes it
  where you can read it.
- **`vx show`, `--dry`, MCP's `listTasks`** all print the same thing a
  human would type.

## The environment is declared too

A command's environment is part of what it does, so it is not
inherited wholesale. Each task gets an isolated environment built from
`exec.env`: values you set, variables you `passThrough` from the parent
(present, but not in the key), and variables under `cache.inputs.env`
(present, and in the key). `PATH` is prepended with the project's
`node_modules/.bin` so `tsc` resolves without `npx`. A variable that
changes the output and is not declared is the single most common
under-declaration, and `vx why`'s "unchanged key, re-executed" verdict
is how it shows up.

Two variables are always set: the workspace vx is running and the task
id, so a command that runs `vx` itself against the same workspace is
refused instead of recursing into the same cache.

## The API is the one you already have

The practical consequence is that vx never needs a plugin for a tool.
There is no `@vzn/vx-vite`, no `@vzn/vx-jest`, and there is not going
to be one, because `vite build` and `jest` are already the API. The
repository briefly shipped a package that inferred tasks from tool
configs and retired it: technology-specific knowledge is the
community's to write as presets, in TypeScript, on top of a runner that
only knows what a command is.

Reference: [Running tasks](../../guides/running-tasks/) and
[Environment variables](../../guides/environment-variables/).
