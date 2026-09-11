---
title: Introduction
description: What vx is, who it's for, and why it exists — a task runner and content-addressed cache for JavaScript monorepos that does one thing, does it right, and lets everything else be built on top.
---

vx is a **task runner and build cache for JavaScript monorepos**. You
describe each package's tasks in a `vx.config.ts`; vx builds the
dependency graph, runs tasks in parallel in the right order, and caches
every result by the content of its inputs. Run the same thing twice and
the second run replays from cache in milliseconds.

If you've used Turborepo or Nx, that shape is familiar. Two things are
different. vx treats **a cache that cannot be wrong** as the hard part,
not a fast one — and then tells you why it re-ran when it did. And vx
**stops there**: one thing, done right, with documented seams for
everything else. It is what Nx would be if it were not a product.

## One thing, built to be built on

Core is a pipeline — discover projects, evaluate configs, build the task
graph, derive cache keys, schedule, execute, cache, observe — and every
stage has a hook a plugin can fill, on one `VxPlugin` object, in the
order you declare them in `vx.workspace.ts`:

| Stage       | Hook                   | Decides                                                  |
| ----------- | ---------------------- | -------------------------------------------------------- |
| config      | `config(ws, ctx)`      | the workspace config before it is used                   |
| project     | `project(config, ctx)` | which tasks a project has (add, remove, rewrite)         |
| graph       | `graph(nodes, ctx)`    | which edges the run has                                  |
| key         | `key(task, ctx)`       | extra material in the cache key (named in `vx why`)      |
| fingerprint | `fingerprint`          | which root files (a lockfile) the plugin keys per project |
| schedule    | `schedule(nodes, ctx)` | which ready task runs first                              |
| execute     | `executor(ctx)`        | where one task's command runs                            |
| store       | `cache(ctx)`           | where artifacts live                                     |
| observe     | `telemetry(ctx)`       | where run records go                                     |
| cli         | `commands`             | which verbs `vx` has                                     |

Core applies **none** of them by default and names none. What it has is
a floor: running a command on this machine and storing its artifact in
`.vx/cache` are what those words mean when no plugin says otherwise, so
a workspace with no `vx.workspace.ts` runs and caches. A plugin goes in
front of the floor — it takes the tasks and artifacts it accepts, and
what it declines lands on the machine you are sitting at.

That is the whole product boundary. A remote cache, remote execution, a
dashboard, a metrics pipeline, an AI agent's view of your builds, a
framework's task conventions — all of them are packages on those seams,
first-party or yours, and none of them is privileged. Core never grows a
special case for one consumer, and nothing distributed ships in it.

```ts
// vx.workspace.ts — plugins are consulted in this order; the local floor is last
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [pnpm({ scope: 'project' }), reapi({ endpoint: 'cache.example.com:443' })],
})
```

What ships on those seams today, each its own package:

- **[`@vzn/vx-lockfile`](../guides/lockfiles/)** — `pnpm()`, `bun()`,
  `npm()`, `yarn()`: the lockfile keyed per project, so one install
  re-keys only the projects it reaches, and `--affected` follows.
- **[`@vzn/vx-reapi`](../guides/remote-caching/)** — Bazel's Remote
  Execution API: NativeLink, BuildBuddy, Buildbarn and bazel-remote as a
  shared cache _and_ as remote executors.
- **[`@vzn/vx-migrate`](../guides/remote-caching/)** — adoption in one
  package: `turbo()` runs a `turbo.json` workspace under vx with nothing
  written, the CLI writes configs from `turbo.json` or an Nx graph, and
  `turboCache()` / `nxCache()` keep any server speaking Turbo's or Nx's
  cache wire, Vercel's Remote Cache included.
- **[`@vzn/vx-otel`](../guides/otel-bridge/)** — every run as
  OpenTelemetry traces, metrics and logs. No SDK.
- **[`@vzn/vx-github`](../guides/ci/)** — the Actions job summary and a
  Checks API run.
- **[`@vzn/vx-mcp`](../guides/mcp/)** — `vx mcp`, a read-only Model
  Context Protocol server for Claude Code, Cursor and Continue.dev.
- **`@vzn/vx-schedule-history`** — order by the critical path learned
  from your own runs.json` or an Nx graph →
  `vx.config.ts`.

Plugins for a given framework or tool — Vite's tasks, Next's outputs,
a test runner's conventions — are the community's to write on the
`project` seam ([Writing a vx plugin](../guides/plugins/)); core's
authors name no tool.

## The problem vx is actually built around

A slow build costs you minutes. A **wrong** build costs you a day, and
it does it quietly — a stale cache hit replays outputs from a build
whose inputs are gone, the run goes green, and nothing downstream can
tell. It is the one failure where "it passed" is the symptom.

Almost every design decision is a response to that:

- **Your config is a program, and vx hashes what it evaluates to.**
  `vx.config.ts` is real TypeScript. A tool that hashes the config
  _file_ misses the preset it imported and the value it computed. vx
  hashes the resolved object, so imports participate in cache identity.
- **Strict output ownership.** Declared outputs are wiped before every
  build _and_ every restore, so your tree ends each run bit-identical
  to the cached snapshot. No stale stragglers, ever.
- **Explicit inputs, and a way to enforce them.** vx never guesses your
  inputs by tracing filesystem reads. It asks you to declare them — and
  a task that adds `sandbox` runs with those declared paths as the only
  ones it can read, so an _undeclared_ read fails instead of lurking.
- **`vx why` answers the question the hash can't.** A cache key is one
  opaque number. vx persists the per-component fingerprint behind it, so
  it can name the exact file, env var, upstream or plugin part that moved.
- **Flaky tasks are found, not guessed.** The same inputs both passing
  and failing is the definition, and vx holds every hash and outcome
  locally: a run names them in its footer, `--summarize` types them,
  `vx info` lists them. No service.

## What else is different

- **Sparse `^task` bridging.** `^build` reaches _through_ packages that
  don't declare the task to the nearest dependency that does, so you
  don't litter no-op tasks across the monorepo. Turborepo and Nx stop at
  direct dependencies.
- **Daemonless.** No background process, no staleness window, no socket
  state to corrupt — and still faster cold than Nx is daemon-warm.
- **Shell is the API.** A task is a command string. There are no
  JS-function tasks; a plugin can change _where_ a command runs, never
  what it is.
- **Reproducible when you want it.** `vx lock` freezes the resolved
  graph; `vx run --frozen` runs exactly that graph, skipping evaluation.

The full, sourced comparison lives in
[vx vs Turborepo vs Nx](../comparison/); what a Turbo or Nx user relies
on, spelled in vx and pinned by test, is the
[parity map](../parity/). The performance mechanics are in
[Why vx is fast](../concepts/why-vx-is-fast/).

## What vx is _not_

vx is small on purpose. It has **no** generators or scaffolding, **no**
daemon, **no** TUI, **no** cloud and **no** account. It doesn't install
dependencies or manage versions — it runs and caches your tasks and
leaves the rest to the tools you already use, or to a plugin. If you
want code generation and an opinionated plugin ecosystem, Nx is the
better fit, and that's fine.

## Requirements

- **Nothing to run it.** `npm install -g @vzn/vx` (or any package
  manager, or a release asset) puts one self-contained binary on your
  PATH — no Node, no Bun. Your `vx.config.ts` imports `@vzn/vx` for its
  types, so add it as a devDependency too.
- **git.** vx uses git's index to enumerate and hash inputs (the same
  technique Turborepo uses), so your workspace must be a git repository.
- **A pnpm / npm / yarn / Bun workspace** — anything with a
  `pnpm-workspace.yaml` or a `workspaces` field. A single-package repo
  works too.
- **Linux or macOS**, x64 or arm64. On Windows, run vx under WSL —
  POSIX shell is the API.

## Next steps

- **[Quickstart](../quickstart/)** — go from zero to a cached run.
- **[Coming from Turborepo](../migrate/from-turborepo/)** or
  **[from Nx](../migrate/from-nx/)** — migrate an existing repo.
- **[Configuring tasks](../guides/tasks/)** — write your first real
  `vx.config.ts`.
