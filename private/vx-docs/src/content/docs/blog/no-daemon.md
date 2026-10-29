---
title: 'No daemon, and still quick when nothing changed'
date: 2026-09-10T23:51:00Z
authors:
  - vzn
tags:
  - design
  - performance
excerpt: 'vx has no background process watching your files. A run with nothing to do stays quick, and it can never act on a stale view of the tree.'
---

vx runs no background process. When nothing changed, a run over %bench.tasks%
tasks still finishes in %bench.vx.warm%.

| Runner    | Nothing changed | Daemon              |
| --------- | --------------- | ------------------- |
| vx        | %bench.vx.warm% | none                |
| Turborepo | %bench.turbo.warm% | not for `turbo run` |
| Nx        | %bench.nx.warm% | off, as in CI       |

<small>Synthetic monorepo, %bench.projects% projects, %bench.tasks% tasks · concurrency %bench.concurrency% · [benchmarks](../../benchmarks/)</small>

<small>%bench.provenance%</small>

Nx runs a daemon by default. Turborepo shipped one and, since 2.8.11,
no longer uses it for `turbo run`.

## A daemon can be wrong

```mermaid
flowchart LR
  E[file edit] -->|event| D[daemon's copy of the tree]
  D -->|what changed| R[run]
  X[missed event, branch switch, crash] -.-> D
  D -.->|wrong answer| H[stale cache hit]
```

A daemon keeps its own copy of your tree. One missed file event and that
copy is wrong. For a build cache, wrong means old bytes under a green
check.

## vx reads the tree fresh, every run

```mermaid
flowchart LR
  G[git index] -->|file list + hashes| K[cache keys]
  S[git status] -->|dirty files| K
  L[.vx/projects.lock.json] -->|resolved config| K
  K --> R[run: stat outputs, write nothing]
```

Each run asks git, which already holds a hash for every clean file. A
clean tree is keyed with no read of a source file
([how](../keys-from-git/)).

Config comes from the lock file, so no `vx.config.ts` is evaluated. A
hit on an up-to-date tree only checks that the outputs are there
([how](../strict-output-ownership/)).

That is the %bench.vx.warm%. Nothing stays running after it, and a run in a
terminal, in CI or in a container gives the same answer.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
