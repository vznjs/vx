---
title: 'There was no choice on the market'
date: 2026-09-10T23:57:00Z
authors:
  - vzn
tags:
  - comparison
  - design
excerpt: 'Turborepo runs and caches. Nx adds a platform. vx is the runner with open plugin points, and nothing behind a paid cloud.'
---

Turborepo runs and caches. Nx adds a platform around its runner. We
wanted the runner with open plugin points, and nothing behind a paid
cloud. So we built vx.

| Time added over the ideal run, %bench.tasks% tasks | vx | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- |
| Nothing changed | %bench.vx.warm% | %bench.turbo.warm% | %bench.nx.warm% | %bench.vt.warm% |
| Cold build | %bench.vx.cold% | %bench.turbo.cold% | %bench.nx.cold% | %bench.vt.cold% |
| Cold build: CPU the runner burns | %bench.vx.cpu% | %bench.turbo.cpu% | %bench.nx.cpu% | %bench.vt.cpu% |

<small>Synthetic monorepo, %bench.projects% projects, %bench.tasks% tasks, %bench.levels% levels · concurrency %bench.concurrency% · real repos with uneven task times will differ</small>

<small>%bench.provenance%</small>

With nothing changed, Nx adds %bench.nx.warm% against Turborepo's %bench.turbo.warm% and
vx's %bench.vx.warm%, Nx's daemon off as in CI. Source:
[Benchmarks](../../benchmarks/).

## What each one is

| Tool      | In one line                                                                 |
| --------- | --------------------------------------------------------------------------- |
| Turborepo | runs and caches tasks from one `turbo.json`; remote cache over an open API  |
| Nx        | a project graph, `affected` and plugins; distribution and flaky detection in Nx Cloud |
| vx        | runs and caches; where a task runs and where artifacts live are plugins     |

Both got a lot right. Turborepo's `dependsOn` syntax and pnpm-style
`--filter` read the way you think, and vx uses both. Nx's project graph
and `affected` scale to very large repos.

## What vx adds

```mermaid
flowchart LR
  V[vx core: graph, keys, scheduler, local cache] --> P1[remote cache plugin]
  V --> P2[remote execution: @vzn/vx-reapi]
  V --> P3[spread over your CI: @vzn/vx-dte]
  V --> P4[telemetry, CI summaries]
```

- **Keys that are right more often:** [computed
  config](../resolved-config-hashing/), [strict
  outputs](../strict-output-ownership/), no false miss after a commit
  ([keys from git](../keys-from-git/)).
- **Plugins, not a service.** Remote cache, remote execution,
  scheduling and telemetry use a public plugin API. `@vzn/vx-reapi`
  talks to any Bazel Remote Execution server. `@vzn/vx-dte` spreads a
  run over workers your own CI starts.
- **Nothing to keep alive:** no daemon, no account, no cloud.

## The bar

vx has to do what both do. A parity suite writes each Turborepo or Nx
habit in vx and tests it against the real CLI.

Where vx differs (no `--parallel`, because `dependsOn` says the order),
the page says so. Full matrix, with upstream sources: [Compared to
Turborepo, Nx, vite-task](../../comparison/).

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
