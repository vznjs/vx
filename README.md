<p align="center">
  <img src="https://vznjs.github.io/vx/logo-mark.svg" width="72" height="72" alt="vx logo">
</p>

<h1 align="center">vx</h1>

<p align="center">
  <strong>Task orchestration you own.</strong><br>
  vx is a task orchestrator. It runs your tasks in the right order, many at once,<br>
  and never does the same work twice.
</p>

<p align="center">
  JavaScript support comes from plugins, and any other system can hook in the same way.<br>
  No cloud, no account, no paywall.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vzn/vx"><img src="https://img.shields.io/npm/v/@vzn/vx?color=7cb518" alt="npm"></a>
  <a href="https://github.com/vznjs/vx/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush"><img src="https://github.com/vznjs/vx/actions/workflows/ci.yml/badge.svg?branch=main&event=push" alt="CI"></a>
  <a href="https://github.com/vznjs/vx/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://vznjs.github.io/vx/"><img src="https://img.shields.io/badge/docs-vznjs.github.io%2Fvx-c6f84e" alt="Documentation"></a>
</p>

<p align="center">
  <img src="https://vznjs.github.io/vx/demo.svg" alt="vx run build --all, twice. First run: @demo/ui#build, then @demo/web#build, both miss and save. Second run: both up to date in milliseconds.">
</p>

Above: a real run. `@demo/web` uses `@demo/ui`, so ui builds first. The
second run finds nothing changed and runs nothing.

## Start

```sh
bunx @vzn/vx init
```

`init` installs vx and writes `.vx/workspace.ts`, which marks your
workspace root. In a Turborepo or Nx workspace it converts that config too.

You need [Bun](https://bun.com) 1.4.4 or later for `bunx`. vx itself is a
prebuilt binary for Linux (glibc, not Alpine's musl) and macOS.

## A task is one command

Each project lists its tasks in a `vx.config.ts`:

```ts
// packages/web/vx.config.ts
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      dependsOn: ['^build'], // build what web uses first: @demo/ui
      exec: { command: 'vite build' }, // the tool itself, never a package script
      inputs: { files: ['src/**', 'index.html', 'vite.config.ts'] }, // what it reads
      outputs: { files: ['dist/**'] }, // what it writes
      cache: true, // skip it while the inputs stay the same
    },
  },
} satisfies ProjectConfig
```

Save the config to the lock, then run:

```sh
vx lock              # every run reads the lock, so lock after each config change
vx run build --all   # ui, then web
vx run build --all   # nothing changed: up to date
```

Edit `packages/ui/src/index.ts` and both build again.
`vx why @demo/web#build` names that file as the cause.

**Next:** the [Quickstart](https://vznjs.github.io/vx/quickstart/)
caches your first task in five minutes.

## What you get

- **A cache you can trust:** TypeScript configs are evaluated before
  hashing, so imports and computed values are in the key. Outputs are
  wiped before every run and restore: no stale file survives.
- **Sandboxed tasks:** opt in per task; a workspace file the task did
  not declare is out of its reach, so it cannot poison the cache.
- **Clean exits:** Ctrl-C reaps each task's process group.
- **Distributed task execution:** split one CI run across workers your
  own CI starts. No vendor in between.
- **A plugin at every step of a run** (16 hooks, `commands` included):
  remote cache, remote execution, telemetry, CLI verbs. Core needs none.
- **Free:** MIT. No paywall, no cloud, no account.

## Learn vx

The [docs](https://vznjs.github.io/vx/docs/) are one story, in order:

| You want to                                 | Read                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| cache your first task                       | [Quickstart](https://vznjs.github.io/vx/quickstart/)                                      |
| move from Turborepo or Nx                   | [Migrate](https://vznjs.github.io/vx/docs/migrate/)                                       |
| run a task in every package, upstream first | [Tasks](https://vznjs.github.io/vx/docs/tasks/)                                           |
| run only what a branch changed              | [Running tasks](https://vznjs.github.io/vx/docs/running-tasks/)                           |
| know why a task ran again                   | [Caching](https://vznjs.github.io/vx/docs/caching/)                                       |
| check every push on CI                      | [CI](https://vznjs.github.io/vx/docs/ci/)                                                 |
| share the cache between CI jobs             | [Remote cache](https://vznjs.github.io/vx/docs/remote-cache/)                             |
| split one CI run across machines            | [Distributed task execution](https://vznjs.github.io/vx/docs/distributed-task-execution/) |
| add your own behaviour                      | [Plugins](https://vznjs.github.io/vx/docs/plugins/)                                       |
| look up a command or a field                | [CLI](https://vznjs.github.io/vx/cli/), [config](https://vznjs.github.io/vx/schema/)      |

## Plugins

Each adds what core leaves out. Declare it in `.vx/workspace.ts`; with
none, vx runs and caches on your machine.

| Package                                                                           | What it adds                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@vzn/vx-lockfile`](https://vznjs.github.io/vx/plugins/vx-lockfile/)             | Keys each project on its own dependencies: pnpm, bun, npm, yarn      |
| [`@vzn/vx-migrate`](https://vznjs.github.io/vx/plugins/vx-migrate/)               | Converts Turborepo or Nx config, and keeps their remote cache        |
| [`@vzn/vx-cache`](https://vznjs.github.io/vx/plugins/vx-cache/)                   | Remote cache for CI jobs, on your cache server                       |
| [`@vzn/vx-cache-server`](https://vznjs.github.io/vx/plugins/vx-cache-server/)     | The cache server you host: Bun or Docker with S3, or Workers with R2 |
| [`@vzn/vx-dte`](https://vznjs.github.io/vx/plugins/vx-dte/)                       | Distributed task execution over workers your CI starts               |
| [`@vzn/vx-dte-server`](https://vznjs.github.io/vx/plugins/vx-dte-server/)         | The relay where a run meets its workers: Workers, Bun or Docker      |
| [`@vzn/vx-history`](https://vznjs.github.io/vx/plugins/vx-history/)               | Starts first the tasks the rest wait on, learned from past runs      |
| [`@vzn/vx-history-server`](https://vznjs.github.io/vx/plugins/vx-history-server/) | The task timings server `vxHistory()` reads: Bun, Docker or Workers  |
| [`@vzn/vx-ci`](https://vznjs.github.io/vx/plugins/vx-ci/)                         | A GitHub Actions job summary                                         |
| [`@vzn/vx-otel`](https://vznjs.github.io/vx/plugins/vx-otel/)                     | OpenTelemetry traces, metrics and logs, no SDK                       |
| [`@vzn/vx-reapi`](https://vznjs.github.io/vx/plugins/vx-reapi/)                   | Remote cache and remote execution over Bazel's REAPI                 |
| [`@vzn/vx-devtools`](https://vznjs.github.io/vx/plugins/vx-devtools/)             | The CI token check the servers and plugins share                     |

Write your own: [Write a plugin](https://vznjs.github.io/vx/docs/writing-plugins/).

## How it compares

Every test in vx, Turborepo, Nx, Vite Task, Nix and moon, turned into one
suite and run sandboxed against each tool. An issue is a case a tool
supports but gets wrong.

| Tool              | Cases passed   | Issues |
| ----------------- | -------------- | ------ |
| **vx**            | 1,947 of 2,016 | **0**  |
| Nx 24.0.2         | 1,342 of 2,016 | 410    |
| Turborepo 2.11.10 | 1,319 of 2,016 | 396    |
| moon 2.6.5        | 1,201 of 2,016 | 427    |
| Nix 2.34.6        | 1,051 of 2,016 | 274    |
| Vite Task 1.4.0   | 972 of 2,016   | 349    |

vx has 0 issues in every area: cache, inputs, outputs, affected, sandbox
and watch. Every case, every tool: [conformance](https://vznjs.github.io/vx/conformance/).
Speed, same commands on the same machine: [benchmarks](https://vznjs.github.io/vx/benchmarks/).

## Status

**Pre-alpha.** This workspace lints, tests and builds itself with vx.
The config may still change before 1.0.

vx takes issues, not pull requests: report a bug or ask for a feature in
[issues](https://github.com/vznjs/vx/issues).

## License

[MIT](https://github.com/vznjs/vx/blob/main/LICENSE). The prebuilt binaries
embed Bun and a few npm packages under permissive licenses; their notices
ship as [THIRD_PARTY_NOTICES.txt](https://github.com/vznjs/vx/blob/main/packages/vx/THIRD_PARTY_NOTICES.txt)
in each platform package and GitHub release.
