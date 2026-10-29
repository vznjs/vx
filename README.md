<p align="center">
  <img src="https://vznjs.github.io/vx/logo-mark.svg" width="72" height="72" alt="vx logo">
</p>

<h1 align="center">vx</h1>

<p align="center">
  <strong>Task orchestration you own.</strong><br>
  Correct, sandboxed, extensible. No cloud, no account, no paywall.<br>
  <a href="https://vznjs.github.io/vx/"><strong>vznjs.github.io/vx</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vzn/vx"><img src="https://img.shields.io/npm/v/@vzn/vx?color=7cb518" alt="npm"></a>
  <a href="https://github.com/vznjs/vx/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush"><img src="https://github.com/vznjs/vx/actions/workflows/ci.yml/badge.svg?branch=main&event=push" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://vznjs.github.io/vx/"><img src="https://img.shields.io/badge/docs-vznjs.github.io%2Fvx-c6f84e" alt="Documentation"></a>
</p>

## What vx is

Task orchestration with a cache you can trust, on a core you can extend.
Each task is one shell command with declared inputs and outputs; vx runs
them in dependency order and replays results from a content-addressed cache.

## Quick start

In a git repo:

```sh
bunx @vzn/vx init   # installs vx, writes an empty root vx.config.ts and the lockfile plugin
```

A prebuilt binary for Linux (glibc, not Alpine's musl) and macOS, x64 and
arm64. Windows: run vx inside WSL2.

A task runs its tool directly, never through a package script. Cache one by
saying what it reads and writes:

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'], // dependencies build first
      inputs: { files: ['src/**', 'tsconfig.json'] },
      cache: {
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

```sh
vx run build --all    # builds, in dependency order; stores the results
vx run build --all    # nothing changed: up-to-date, in milliseconds
rm -rf packages/*/dist
vx run build --all    # restored from the cache, not rebuilt
```

<img src="https://vznjs.github.io/vx/demo.svg" width="760" alt="vx run ci --all on examples/basic: cold, three tasks run; again, three up-to-date.">

### When to run `vx lock`

`init` also writes `.vx/projects.lock.json`, every project's config as it evaluated.
Commit it. Every run reads its configs from the lock, so run
`vx lock` and commit the lock again after you:

- edit any `vx.config.ts` or `.vx/workspace.ts`,
- update dependencies or plugins,
- change a file a config imports.

Otherwise runs keep the old configs. On CI, `vx lock --check` fails a
stale lock before any task runs.

Starters: [`examples/basic`](examples/basic), and
[`examples/ci`](examples/ci) with a GitHub Actions workflow; CI runs both
on every commit. The [CI guide](https://vznjs.github.io/vx/docs/ci/)
explains the workflow.
More: [Quickstart](https://vznjs.github.io/vx/quickstart/) ·
[Configure](https://vznjs.github.io/vx/docs/workspace/) ·
[CLI](packages/vx/docs/cli.md) · [every config field](packages/vx/docs/schema.md).

## A foundation you own

- **A cache you can trust:** TypeScript configs are evaluated before
  hashing, so imports and computed values are in the key. Outputs are
  wiped before every run and restore: no stale file survives.
- **Sandboxed tasks:** opt in per task; a workspace file the task did
  not declare is out of its reach, so it cannot poison the cache.
- **Clean exits:** Ctrl-C reaps each task's process group.
- **Plugins at every stage** (15 hooks, `commands` included): remote cache, remote execution, telemetry,
  CLI verbs. Core ships none and needs none.
- **Free:** MIT. No paywall, no cloud, no account.

## Plugins

What vx can do, not what it is limited to. Declared in `.vx/workspace.ts`; without any, vx runs and caches locally.

| Package                                                | What it adds                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`@vzn/vx-migrate`](packages/vx-migrate)               | Migrate from Turbo or Nx: write native configs, keep its remote cache         |
| [`@vzn/vx-reapi`](packages/vx-reapi)                   | Remote cache and remote execution over Bazel's REAPI (NativeLink, BuildBuddy) |
| [`@vzn/vx-lockfile`](packages/vx-lockfile)             | Key each project on its own lockfile slice: pnpm, bun, npm, yarn              |
| [`@vzn/vx-otel`](packages/vx-otel)                     | OpenTelemetry traces, metrics and logs, no SDK                                |
| [`@vzn/vx-ci`](packages/vx-ci)                         | GitHub Actions job summary                                                    |
| [`@vzn/vx-history`](packages/vx-history)               | Schedule by the critical path learned from past runs                          |
| [`@vzn/vx-cache`](packages/vx-cache)                   | Remote cache for CI jobs, on a vx cache server                                |
| [`@vzn/vx-cache-server`](packages/vx-cache-server)     | The cache server you host: Bun or Docker with S3, or Workers with R2          |
| [`@vzn/vx-history-server`](packages/vx-history-server) | The task timings server `vxHistory()` reads: Bun, Docker or Workers           |
| [`@vzn/vx-devtools`](packages/vx-devtools)             | Code the servers and plugins share: the CI OIDC token check                   |
| [`@vzn/vx-dte`](packages/vx-dte)                       | Spread one run over workers your own CI starts                                |
| [`@vzn/vx-dte-server`](packages/vx-dte-server)         | The relay `dte()` meets its workers at: Workers, Bun or Docker                |

Hosting the three servers: [servers docs](https://vznjs.github.io/vx/docs/servers/).

Write your own: [plugin guide](https://vznjs.github.io/vx/docs/writing-plugins/) ·
[architecture](packages/vx/docs/architecture.md).

## Coming from Turbo or Nx

Beside `turbo.json` or `nx.json`, `bunx @vzn/vx init` runs `@vzn/vx-migrate`:
it writes a `vx.config.ts` per package from `turbo.json` or the Nx graph,
and you keep those and delete the old config. `vx init --keep` writes only
a `.vx/workspace.ts` that maps the old config instead, and its lock: a temporary start,
not a way to run the repo. The benchmark below uses native vx config.
[Migration guide](https://vznjs.github.io/vx/guides/migrate/).

## How it compares

|                    | vx                                        | Turborepo                      | Nx               |
| ------------------ | ----------------------------------------- | ------------------------------ | ---------------- |
| Config             | TypeScript, evaluated into the cache key  | JSON (static)                  | JSON (static)    |
| Output ownership   | **Strict**: wiped before exec and restore | Additive (stale files survive) | Additive         |
| Clean-tree hashing | **No source reads** (git index OIDs)      | git OIDs                       | re-hash / daemon |
| Daemon             | **None**                                  | None for `turbo run`           | On by default    |
| Per-task sandbox   | **Yes**: kernel-level, opt-in, local      | No                             | On Nx Cloud only |
| Plugin API         | **Yes**: every pipeline stage             | No                             | Yes (TS-tied)    |
| Install            | **Single binary**; no Bun, Node optional  | npm + Node                     | npm + Node       |

Every gap, and when another tool is the better pick:
[comparison](packages/vx/docs/comparison.md) ·
[vx, Turborepo, Nx, Bazel](https://vznjs.github.io/vx/compare/).

## Fast, without trading correctness

- **Nothing boots per task:** no daemon, no Node process; vx spawns your command.
- **No source-file reads to hash:** on a clean tree, keys come from git's index; each project's `package.json` and the lockfile are still read.
- **One pass:** one git walk per run; each stat and lookup happens once.

The head-to-head against Turborepo, Nx and Vite Task, each in its own
native config, is re-measured on every change to vx and published on the
site: [benchmarks](https://vznjs.github.io/vx/benchmarks/).

## Status

**Pre-alpha**, dogfooded: this repo lints, tests and builds itself with
vx. The schema may still change; 1.0's promise:
[versioning-1.0.md](packages/vx/docs/design/versioning-1.0.md).

## Issues

vx is maintained by VZN and takes issues, not pull requests: report a
bug or ask for a feature in [issues](https://github.com/vznjs/vx/issues).

## License

vx is [MIT](LICENSE) licensed. The prebuilt binaries embed Bun and a few npm packages under permissive licenses; their notices ship as [THIRD_PARTY_NOTICES.txt](packages/vx/THIRD_PARTY_NOTICES.txt) in each platform package and GitHub release.
