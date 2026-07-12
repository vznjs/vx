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
is the combination vx targets: **Turborepo's simplicity, more capability
than either, and the fastest warm runs in the category — with no daemon
and no plugins.**

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

## What makes vx different

vx is deliberately shaped like Turborepo — per-package config, an opt-in
content-addressed cache, a topological scheduler, the Turborepo
remote-cache wire — with a few decisive swaps:

- **Your config is a program.** `vx.config.ts` is real TypeScript.
  Imports, shared presets, and computed values all participate in the
  cache key (vx hashes the *resolved* config object, not the file
  bytes). Turborepo and Nx hash static JSON and miss this.
- **Sparse `^task` bridging.** `^build` reaches *through* packages that
  don't declare the task to the nearest dependency that does, so you
  don't litter no-op tasks across the monorepo. Turborepo and Nx stop at
  direct dependencies.
- **Strict output ownership.** Declared outputs are wiped before every
  build *and* every restore, so your working tree ends each run
  bit-identical to the cached snapshot. No stale stragglers, ever.
- **Daemonless.** No background process, no staleness window, no socket
  state to corrupt — and still faster cold than Nx is daemon-warm.
- **Shell is the API.** A task is a command string. There are no
  JS-function tasks and no executor plugin protocol to learn or
  maintain.

The full, sourced comparison lives in
[vx vs Turborepo vs Nx](../comparison/). The performance mechanics are in
[Why vx is fast](../concepts/why-vx-is-fast/).

## The open platform layer

Beyond the core task runner, vx ships an OSS open platform — every
contract is documented; every wire is JSON-RPC 2.0. None of these
require additional services:

- **[vx mcp](../guides/mcp/)** — Model Context Protocol server. `vx mcp`
  over stdio, or `POST /mcp` on the `vx-cloud` platform. Claude Code,
  Cursor, Continue.dev query cache stats and run history through the
  standard agent-tool protocol.
- **[Distributed CI](../guides/distributed-ci/)** — `vx-cloud agent`s
  attach to a `vx-cloud` platform session and execute your task graph
  across machines (the Nx-Cloud-DTE equivalent). Content-addressed; the
  submitting run self-registers, so local + remote agents mix.
- **[Plugin API](../guides/plugins/)** — register lifecycle hooks in
  `vx.workspace.ts`. Forward outcomes to Sentry, post to Slack, ship
  metrics anywhere.
- **[Predictive scheduling](../guides/predictive-scheduling/)** — opt
  in with `predictive: true`; the scheduler reads run history and
  dispatches by expected remaining critical path.
- **[Self-host vx-cloud](../guides/self-hosting/)** — the self-hosted CI
  platform, `docker compose up`: accounts, orgs, RBAC, the dashboard, the
  `/v1/*` analytics, the `/v1/cache` remote cache, and `/mcp`, in one
  stateless process backed by Postgres + an S3 bucket.
- **[Dashboard](../guides/dashboard/)** — Solid SPA embedded in the
  `vx-cloud` server (nothing to build). Account login, an org switcher,
  an Admin area, and run history, per-task averages, cache stats, and
  insights across your workspaces.
- **[OpenTelemetry CI/CD spans](../guides/otel-bridge/)** — set
  `OTEL_EXPORTER_OTLP_ENDPOINT`, install the three OTel peers; every
  event lands in Grafana / Honeycomb / Datadog / Tempo natively, no
  bridge package.
- **[Wire protocol](../guides/wire-protocol/)** — the `vx-cloud` platform
  speaks JSON-RPC 2.0 over WS, SSE, and NDJSON. `curl -N
  https://vx.example.com/events` streams every run envelope.

## What vx is *not*

vx is small on purpose. It deliberately has **no** generators or
scaffolding, **no** plugin/executor protocol, **no** daemon, and **no**
TUI. It doesn't do dependency installation or version management — it
runs and caches your tasks, and leaves the rest to the tools you already
use. If you need code generation and an opinionated plugin ecosystem, Nx
is the better fit and that's fine.

## Requirements

- **Bun ≥ 1.3.** vx is Bun-native — it ships as TypeScript that Bun runs
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
