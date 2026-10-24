---
title: 'See what a task really is'
date: 2026-10-09T00:40:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'vx show prints a project or a task as the run sees it: the evaluated config, after presets, plugins and TypeScript have had their say.'
---

A `vx.config.ts` is TypeScript: presets compose, plugins add tasks, a
function computes a command. `vx show` prints the task as the run sees
it:

```sh frame="terminal"
$ vx show packages/a#build

─ packages/a#build ───────────────────────────────────────────
  dir            packages/a
  command        bun build src/index.ts --outdir dist
  inputs.files   src/**
  outputs.files  dist/**
```

This is the evaluated config the cache key sees, not the source text.
A preset that sets `outputs` or a plugin that rewrites a command shows
here.

## Every project, one line each

```sh frame="terminal"
$ vx show
  project     dir         tasks
  packages/a  packages/a  7 tasks
  packages/b  packages/b  4 tasks
  packages/c  packages/c  5 tasks
  packages/d  packages/d  2 tasks
```

Demo workspace, vx at `69617eb`, 2026-10-23.

## Read from the lock

```
vx.config.ts + presets + plugins → vx lock → .vx/projects.lock.json → vx show
                                                                    → cache key
```

`vx show` reads the lock, as a run does, so an edit shows after
`vx lock`. `vx show --affected` lists the projects a change reaches,
without running anything.

## For agents

`--format json` prints the object itself:

```json
{"name":"packages/a","dir":"packages/a","task":"build","config":{"exec":{"command":"bun build src/index.ts --outdir dist"},"inputs":{"files":["src/**"]},"cache":{"outputs":{"files":["dist/**"]}}}}
```

On this repository `vx show --format json` covers 13 projects and 201
tasks in 5,807 bytes.

Reference: [the CLI](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
