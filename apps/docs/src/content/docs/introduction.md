---
title: Introduction
description: What vx is, who it's for, and why it exists — a content-addressed task runner for JavaScript monorepos that's simpler than Nx and more capable than Turborepo.
---

vx is a **task runner and build cache for JavaScript monorepos**. You
describe each package's tasks in a `vx.config.ts`; vx builds the
dependency graph, runs tasks in parallel in the right order, and caches
every result by the content of its inputs. Run the same thing twice and
the second run replays from cache in milliseconds.

If you've used Turborepo or Nx, that shape is familiar. What's different
is what vx treats as the hard part: **not making the cache fast, but
making it impossible for the cache to be wrong** — and then being able
to tell you why it re-ran when it did.

## Who vx is for

You'll feel at home with vx if you are:

- **Hitting Turborepo's ceiling.** You love how simple it is, but
  `turbo.json` can't express what you need, additive restores leave
  stale files in `dist/`, and the cache misses things your build
  actually depends on.
- **Tired of Nx's weight.** You want fast, correct caching without a
  long-running daemon, a plugin graph, generators, and a mental model
  that takes weeks to internalize.
- **Starting fresh** and want something that stays out of your way: real
  TypeScript config, shell commands, one binary, no background process.

## The problem vx is actually built around

A slow build costs you minutes. A **wrong** build costs you a day, and
it does it quietly — a stale cache hit replays outputs from a build
whose inputs are gone, the run goes green, and nothing downstream can
tell. It is the one failure where "it passed" is the symptom.

Almost every design decision below is a response to that:

- **Your config is a program, and vx hashes what it evaluates to.**
  `vx.config.ts` is real TypeScript. A tool that hashes the config
  *file* misses the preset it imported and the value it computed. vx
  hashes the resolved object, so imports participate in cache identity.
- **Strict output ownership.** Declared outputs are wiped before every
  build *and* every restore, so your tree ends each run bit-identical
  to the cached snapshot. No stale stragglers, ever.
- **Explicit inputs, and a way to prove them.** vx never guesses your
  inputs by tracing filesystem reads. It asks you to declare them — and
  then `vx run --verify=inputs` runs the task under an OS sandbox so an
  *undeclared* read is a reported failure rather than a latent one.
- **`vx why` answers the question the hash can't.** A cache key is one
  opaque number. vx persists the per-component fingerprint behind it, so
  it can name the exact file, env var or upstream that moved.

## What else is different

- **Sparse `^task` bridging.** `^build` reaches *through* packages that
  don't declare the task to the nearest dependency that does, so you
  don't litter no-op tasks across the monorepo. Turborepo and Nx stop at
  direct dependencies.
- **Daemonless.** No background process, no staleness window, no socket
  state to corrupt — and still faster cold than Nx is daemon-warm.
- **Shell is the API.** A task is a command string. There are no
  JS-function tasks; a plugin can change *where* a command runs, never
  what it is.

The full, sourced comparison lives in
[vx vs Turborepo vs Nx](../comparison/). The performance mechanics are in
[Why vx is fast](../concepts/why-vx-is-fast/).

## Core is neutral — plugins decide what happens

This is the part most likely to surprise you, and it is deliberate.

vx core ships exactly **three seams** and applies none of them by
default:

| Seam        | Decides                             |
| ----------- | ----------------------------------- |
| `executor`  | where one task's command runs       |
| `cache`     | where artifacts live                |
| `telemetry` | where run records go                |

Even vx's own local executor and local cache are plugins, declared in
`vx.workspace.ts` like any third-party one. A workspace that declares
none fails before a single task runs, and tells you what to add.

That sounds like ceremony; it buys something specific. There is no
privileged first-party path — a remote cache, remote execution, a
dashboard, or a metrics pipeline are all built on the same contracts
core's own defaults use, so none of them is a second-class citizen, and
core never grows a special case for one consumer.

```ts
// vx.workspace.ts — nothing runs until you say what runs it
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
```

What ships on those seams today:

- **[`@vzn/vx-reapi`](../guides/remote-caching/)** — speaks Bazel's
  Remote Execution API, so NativeLink, BuildBuddy, Buildbarn and
  bazel-remote work as a shared cache *and* as a remote executor that
  runs your tasks on their workers.
- **[`@vzn/vx-otel`](../guides/otel-bridge/)** — exports every run as
  OpenTelemetry traces, metrics and logs over OTLP/HTTP. No SDK, no peer
  dependencies; set an endpoint and it activates.
- **[`@vzn/vx-github`](../guides/ci/)** — writes the GitHub Actions job
  summary and a Checks API run.
- **[vx mcp](../guides/mcp/)** — a Model Context Protocol server over
  stdio, so Claude Code, Cursor and Continue.dev can query your cache
  and run history. Needs no service.
- **[Predictive scheduling](../guides/predictive-scheduling/)** — opt in
  with `predictive: true` and the scheduler orders work by expected
  remaining critical path, learned from your own run history.

## What vx is *not*

vx is small on purpose. It has **no** generators or scaffolding, **no**
daemon, and **no** TUI. It doesn't install dependencies or manage
versions — it runs and caches your tasks and leaves the rest to the
tools you already use. If you want code generation and an opinionated
plugin ecosystem, Nx is the better fit, and that's fine.

## Requirements

- **Bun ≥ 1.4.** vx is Bun-native — it ships as TypeScript that Bun runs
  directly, with no build step. There is no Node fallback.
- **git.** vx uses git's index to enumerate and hash inputs (the same
  technique Turborepo uses), so your workspace must be a git repository.
- **A pnpm / npm / yarn / Bun workspace** — anything with a
  `pnpm-workspace.yaml` or a `workspaces` field. A single-package repo
  works too.

## Next steps

- **[Quickstart](../quickstart/)** — go from zero to a cached run.
- **[Coming from Turborepo](../migrate/from-turborepo/)** or
  **[from Nx](../migrate/from-nx/)** — migrate an existing repo.
- **[Configuring tasks](../guides/tasks/)** — write your first real
  `vx.config.ts`.
