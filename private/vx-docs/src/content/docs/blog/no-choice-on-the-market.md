---
title: 'There was no choice on the market'
date: 2026-09-10T23:57:00Z
authors:
  - vzn
tags:
  - comparison
  - design
excerpt: 'Turborepo runs and caches. Nx adds a platform around its runner. vx is the runner with open seams: remote cache, remote execution and scheduling are plugins anyone can write, and nothing sits behind a paid cloud.'
---

| Time added over the ideal run, 9,603 tasks | vx      | Turborepo  | Nx         | Vite Task |
| ------------------------------------------ | ------- | ---------- | ---------- | --------- |
| Nothing changed                            | 720 ms  | 1.05 s     | 26.21 s    | 12.89 s   |
| Cold build                                 | 9.27 s  | 11.05 s    | 5 min 1 s  | 9.89 s    |
| Cold build: CPU the runner burns           | 49.58 s | 1 min 30 s | 7 min 43 s | 29.74 s   |

Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
Run 2026-10-23 on linux x64, 4 cores, concurrency 10: vx at commit 0be036747, Turborepo 2.11.10, Nx 24.0.1, Vite Task (vite-plus) 1.4.0.

With nothing changed, Nx adds 26.21 s against Turborepo's 1.05 s and
vx's 720 ms, Nx's daemon off as in CI. Source:
[Benchmarks](../../benchmarks/).

## What each one is

| Tool      | In one line                                                                 |
| --------- | --------------------------------------------------------------------------- |
| Turborepo | runs and caches tasks from one `turbo.json`; remote cache over an open API  |
| Nx        | a project graph, `affected` and plugins; distribution and flaky detection in Nx Cloud |
| vx        | runs and caches; where a task runs and where artifacts live are plugins     |

Both got important things right. Turborepo's `dependsOn` micro-syntax
and pnpm-style `--filter` read the way you think, and vx uses both. Nx's
project graph and `affected` scale to very large repositories.

## What vx adds

- **A key that is right in more cases:** [computed
  config](../resolved-config-hashing/), [strict
  outputs](../strict-output-ownership/), no spurious miss at a commit
  ([keys from git](../keys-from-git/)).
- **Seams instead of a service.** Remote cache, remote execution,
  scheduling and telemetry are plugin stages on a public API.
  `@vzn/vx-reapi` speaks the Bazel Remote Execution API to any server.
  `@vzn/vx-dte` spreads a run over workers your own CI starts, through a
  relay you host.
- **Nothing to keep alive:** no daemon, no account, no cloud, no
  dashboard.

## The bar

vx has to clear the same bar as both, and the way to know is to run
their behaviours. The parity suite spells each behaviour a Turborepo or
Nx user reaches for in vx and pins it with a test that runs the real
CLI. Where vx differs on purpose (no `--parallel`, because `dependsOn`
is explicit) the page says so. The matrix is [Compared to Turborepo,
Nx, vite-task](../../comparison/); every claim cites a file upstream so
it can be checked as they change.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
