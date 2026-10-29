---
title: vx vs Turborepo
description: The same benchmark graph run by both, what each one asks of you, and when Turborepo is the better pick.
---

Both tools run the tasks of a JavaScript monorepo and cache their
results. This page puts them side by side on one benchmark, feature by
feature, and says when Turborepo is the better choice.

The design choices behind both are on [vx, Turborepo, Nx, Bazel](../).

## The numbers

<!-- bench: filled from src/data/bench.json at build (src/bench/format.ts) -->

| Time added over the ideal run, %bench.projects% projects, %bench.tasks% tasks | vx | Turborepo |
| --- | --- | --- |
| Nothing changed | %bench.vx.warm% | %bench.turbo.warm% |
| Nothing changed, outputs restored | %bench.vx.restore% | %bench.turbo.restore% |
| Cold build | %bench.vx.cold% | %bench.turbo.cold% |
| Cold build: CPU the runner burns | %bench.vx.cpu% | %bench.turbo.cpu% |

Time each tool adds over the ideal run; lower is better.

Benchmark workload: a synthetic monorepo of %bench.projects% projects and %bench.tasks% tasks in %bench.levels% dependency levels, with five core libraries a quarter of the projects use.

Task times: build %bench.task.build%, test and typecheck %bench.task.test%, lint %bench.task.lint%, publish %bench.task.publish%. Real repos with uneven task times differ.

%bench.provenance%

Same graph, commands and concurrency, each tool in its own native config: [how it is measured](../../benchmarks/).

<!-- bench:end -->

## Feature by feature

|                            | vx                                                                                         | Turborepo                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Config                     | TypeScript, evaluated into the cache key                                                   | JSON (`turbo.json`), static                  |
| Default inputs             | None: you declare `inputs.files`                                                           | Every tracked file in the package            |
| Outputs on run and restore | Exactly the cached files: no stale file survives a hit                                     | Additive: stale files survive                |
| Task sandbox               | Free and local, opt-in per task (Linux, macOS)                                             | Its docs describe no file sandbox            |
| Clean-tree hashing         | No source reads: git index OIDs                                                            | git OIDs                                     |
| Daemon                     | None                                                                                       | None for `turbo run` since 2.8.11            |
| Remote cache               | Any wire through a plugin; `turboCache()` speaks Turbo's own                               | Vercel's `/v8/artifacts`, hosted or your own |
| Plugins                    | Every pipeline stage, 15 hooks; core applies none                                          | Its docs describe no plugin surface          |
| Why a task missed          | `vx why` diffs two keys: the file, env var or upstream that moved                          | `--summarize` shows hashes, not the diff     |
| Watch mode                 | `vx watch <task>`                                                                          | `turbo watch`                                |
| Prune for Docker           | No equivalent                                                                              | `turbo prune`                                |
| Import boundaries          | No: a lint's job                                                                           | `boundaries`                                 |
| Non-JS projects            | Yes: any directory with a `vx.config`; edges are declared, not read from Cargo or Go files | Experimental: Go, Cargo, uv                  |
| Terminal output            | Streamed blocks you can scroll, copy and pipe                                              | Terminal UI                                  |
| Windows                    | WSL2                                                                                       | Native                                       |
| Install                    | One binary; no Bun, Node optional                                                          | npm and Node                                 |

Every row is held in [vx vs Turborepo vs Nx](../../comparison/), which
links each claim to its source.

## A cache you can trust

- **Your config is in the key.** vx evaluates each TypeScript config
  before hashing, so imports and computed values move the key.
- **Outputs are owned.** Declared outputs are wiped before every run,
  and a restore removes what its entry does not hold, so a file from last
  week's build cannot ride along on a hit.
- **Tasks can prove their reads.** Opt a task into the
  [sandbox](../../docs/sandboxing/), and a workspace file it did not
  declare is out of its reach. A violation fails the task, and a failed
  task is never cached.
- **Pull requests keep to their own branch.** `turboCache()` names the
  branches a read may see (`x-artifact-read-scopes`).

  The server's OIDC trust policy decides where a write lands, so a pull
  request reads main's entries and never writes them ([security
  model](../../security/#cache-poisoning)).

## Where Turborepo wins

Pick Turborepo if one of these decides it for you:

- **Caching before anyone writes an input list.** Turborepo hashes every
  tracked file in a package by default
  ([`inputs`](https://turborepo.com/docs/reference/configuration#inputs)).
  vx makes you declare inputs, and keeping them right is your job.
- **Native Windows.** vx runs under WSL2.
- **A stable release with a support policy, today.** vx is pre-alpha:
  0.0.x on npm, no
  [support policy](https://turborepo.com/docs/support-policy) yet.
- **A terminal UI and import boundaries.** Both ship in Turborepo. vx
  streams plain blocks and leaves boundaries to your linter.
- **Go, Cargo or uv in the graph.** Turborepo has experimental support.
  vx runs JavaScript workspaces only.

## Switch in one command

```sh
vx init
vx run build --all
```

`vx init` finds `turbo.json` and writes one `vx.config.ts` per package,
plus the workspace file, through
[`@vzn/vx-migrate`](../../guides/migrate/).

Anything Turbo can say that vx cannot becomes a `TODO(vx-migrate)`
comment, never a silent wrong value. Your `package.json` scripts are
never edited.

Keep your remote cache with `turboCache()`: any server speaking Turbo's
`/v8/artifacts` API, Vercel's hosted cache included. The numbers above
are native vx config.

## FAQ

**Do my Turbo flags still work?**
`vx run` takes each Turbo flag as it is (`--filter`, `--affected`,
`--concurrency`), rewrites it to vx's spelling, or refuses it and names the
vx way. None is dropped in silence.

**Can I keep Vercel Remote Cache?**
Yes. Set `TURBO_TOKEN` and `TURBO_TEAM` (or, on a laptop, type the token
once when asked; it stays in the OS keychain), declare `turboCache()`,
and vx stores its own artifacts there.

Turbo cannot read what vx stores, and vx does not read Turbo's entries.

**What does it cost?**
Nothing. vx is MIT, with no cloud and no account.

**Do I need Bun?**
No. The npm package installs a prebuilt binary for Linux and macOS, x64 and
arm64. Windows: use WSL2.
