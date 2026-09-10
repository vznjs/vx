---
title: 'One binary, nothing to install underneath'
date: 2026-09-10
authors:
  - vzn
tags:
  - dx
  - design
excerpt: "vx ships as one self-contained executable per platform. No Node to pick, no Bun to install, no daemon to start. `npm install -D @vzn/vx` gets you the binary; a release tarball gets you the same binary without npm."
---

The runner for a JavaScript monorepo is the first thing that runs in
CI and the last thing you want to have an opinion about your Node
version. vx is built on Bun, and the way you never notice that is that
you never install Bun.

## What you install

```bash
npm install -D @vzn/vx    # or pnpm add -D · yarn add -D · bun add -d
```

The package ships the prebuilt standalone binary for your platform:
Linux and macOS, x64 and arm64 (Windows under WSL). It is the same
binary the GitHub release carries, so a CI image can fetch the tarball
directly and skip the package manager entirely. There is no postinstall
that compiles anything, no download at first run, and no runtime to
match.

Your tasks are unaffected. `tsc`, `vite`, `eslint` run under whatever
Node your project uses, because a task is a shell command and vx only
prepends the package's `node_modules/.bin` to its `PATH`. vx's runtime
is vx's business.

## What that buys

- **A CI step with no setup.** No `setup-node` before the runner, no
  cache of the runner's own dependencies. Fetch, run.
- **No version skew between the tool and its host.** A compiled binary
  carries its runtime. The `vx` that ran yesterday is the `vx` that
  runs today, byte for byte, on every machine in the team.
- **No runtime to boot before vx's own code runs.** A compiled Bun
  binary starts as itself, which is part of what makes a 50 ms fully
  cached run on a real repository possible at all.
- **`vx.config.ts` evaluated natively.** TypeScript config with no
  transpile step, no `ts-node`, no loader flag. The binary resolves the
  `@vzn/vx` import from your `node_modules`, which is also why the
  package stays in `devDependencies` even when you run the release
  binary: it carries the types.

## Why Bun, and why it does not leak

The core depends on things Bun does natively that would otherwise be
dependencies with their own opinions: `bun:sqlite` for the cache index,
`Bun.Archive` for in-process tar, `Bun.spawn` for the runner,
`Bun.Glob` for input resolution, and `bun build --compile` for the
binary itself. Every dependency in the repository has a written reason
next to it, and the list is short because the runtime covers most of
what a runner needs.

None of that reaches you. A workspace on Node 18 with pnpm and a
`.nvmrc` runs under vx exactly as it does under Turborepo. The one
place Bun shows is if you want to run vx *from source*, which needs
Bun ≥ 1.4; the binary needs nothing.

## No daemon, no service

The binary is also the whole deployment. There is no background
process to start ([by design](../no-daemon/)), no account to log into,
no service to reach. `vx run` in a container with no network does what
`vx run` on a laptop does. The plugins that talk to the outside world
are packages you add, and the [local floor](../the-local-floor/) is
what runs when they are absent or decline.

Install and first run: the [Quickstart](../../quickstart/).
