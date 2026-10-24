---
title: 'See what a task really is'
date: 2026-10-09T00:40:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'vx show prints a task the way the run sees it, after presets and plugins changed it. No guessing what your TypeScript config turned into.'
---

`vx show` prints a task the way the run sees it. Presets, plugins and
computed commands are already applied.

```sh frame="terminal"
$ vx show packages/a#build

─ packages/a#build ───────────────────────────────────────────
  dir            packages/a
  command        bun build src/index.ts --outdir dist
  inputs.files   src/**
  outputs.files  dist/**
```

This is what the cache key is built from. If a preset set `outputs` or
a plugin changed the command, you see it here.

## It reads the same file the run reads

```mermaid
flowchart LR
  C[vx.config.ts + presets + plugins] -->|vx lock| L[.vx/projects.lock.json]
  L --> S[vx show]
  L --> K[cache key]
```

`vx show` reads the lock file, like `vx run`. Change a config, run
`vx lock`, and the change shows.

## Every project on one screen

```sh frame="terminal"
$ vx show
  project     dir         tasks
  packages/a  packages/a  7 tasks
  packages/b  packages/b  4 tasks
  packages/c  packages/c  5 tasks
  packages/d  packages/d  2 tasks
```

`vx show --affected` lists the projects your change reaches, without
running anything.

<small>Demo workspace · vx 69617eb · 2026-10-23</small>

## JSON for scripts and agents

```json
{"name":"packages/a","dir":"packages/a","task":"build","config":{"exec":{"command":"bun build src/index.ts --outdir dist"},"inputs":{"files":["src/**"]},"cache":{"outputs":{"files":["dist/**"]}}}}
```

`--format json` prints the object. On this repository that is 13
projects and 201 tasks in 5,807 bytes.

Reference: [the CLI](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
