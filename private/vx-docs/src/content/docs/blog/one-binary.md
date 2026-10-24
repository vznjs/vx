---
title: 'One binary, nothing to install underneath'
date: 2026-09-10T23:42:00Z
authors:
  - vzn
tags:
  - dx
  - design
excerpt: "vx ships as one self-contained executable per platform. No Node to pick, no Bun to install, no daemon to start. `bun add -d @vzn/vx` gets you the binary; a release tarball gets you the same binary without a package manager."
---

The release binary, built the way the release builds it, on a
1,000-project workspace with everything up to date:

```sh frame="terminal"
$ ls -l vx-linux-x64
-rwxr-xr-x 1 root root 117532848 vx-linux-x64

$ time ./vx-linux-x64 run build --all
real    0m0.163s

$ time bun packages/vx/src/bin.ts run build --all
real    0m0.253s
```

| Same run, 1,000 tasks up to date | Wall time |
| -------------------------------- | --------- |
| release binary (`--bytecode`)    | 163 ms    |
| from source under Bun            | 253 ms    |

Min of 15 runs each, 3 interleaved arms. `private/vx-bench/generate.ts` with 1,000
projects, Linux x64, 4 cores, vx at `22f6eb7`, 2026-10-23. The binary
carries its runtime and its code precompiled, so nothing parses vx
before vx runs. You never install Bun.

## What you install

```bash
bun add -d @vzn/vx
```

The package brings the prebuilt standalone binary for your platform as
a per-platform optional dependency: Linux (glibc, not Alpine's musl)
and macOS, x64 and arm64 (Windows under WSL). It is the same binary the GitHub release carries,
so a CI image can fetch the tarball directly and skip the package
manager entirely. There is no postinstall that compiles anything, no
download at first run, and no runtime to match. The npm package's
`vx` command is a small sh launcher that execs that binary; the
release binary needs no launcher.

Your tasks are unaffected. `tsc`, `vite`, `eslint` run under whatever
Node your project uses, because a task is a shell command and vx only
prepends the project's and the workspace root's `node_modules/.bin` to
its `PATH`. vx's runtime
is vx's business.

## What that buys

- **A CI step with no setup.** No `setup-node` before the runner. Fetch,
  run. Through npm, the launcher costs one shell start first, a few
  milliseconds; Node starts only when no prebuilt binary fits.
- **No version skew.** The `vx` that ran yesterday is the `vx` that runs
  today, byte for byte, on every machine.
- **`vx.config.ts` evaluated natively.** No transpile step, no loader
  flag. The binary resolves `@vzn/vx` from your `node_modules`, which
  is why the package stays in `devDependencies`: it carries the types.

## Why Bun, and why it does not leak

The core depends on things Bun does natively that would otherwise be
dependencies with their own opinions: `bun:sqlite` for the cache index,
`Bun.zstd*` under vx's own streaming tar, `Bun.spawn` for the runner,
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

Install and first run: the [Quickstart](../../quickstart/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
