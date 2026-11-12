---
title: vx on real workspaces
description: Public workspaces on native vx config, timed against the tool they ship with, with the commit, versions and machine for every number.
---

The benchmark on [vx vs Nx](../nx/) is a synthetic graph built to be
fair to every tool.

This page is the other half: real public workspaces, each given native vx
config that follows its `turbo.json`, timed against the Turborepo it
already pins. Both tools run the same tasks with the same number of
workers, five interleaved runs per case, best of five.

<!-- bench: filled from private/vx-bench/real-repos.json at build (src/bench/real.ts) -->

## solidjs/solid

[solidjs/solid](https://github.com/solidjs/solid) at commit
%bench.real.solid.commit%: `build` on the whole workspace, 4 tasks.

| Run                     | vx                            | %bench.real.solid.rival%         |
| ----------------------- | ----------------------------- | -------------------------------- |
| Cold build (total time) | %bench.real.solid.cold.vx%    | %bench.real.solid.cold.rival%    |
| Restore from cache      | %bench.real.solid.restore.vx% | %bench.real.solid.restore.rival% |
| Nothing changed         | %bench.real.solid.noop.vx%    | %bench.real.solid.noop.rival%    |

Run %bench.real.solid.date% on %bench.real.solid.machine%, against
%bench.real.solid.tool%.

## vueuse/vueuse

[vueuse/vueuse](https://github.com/vueuse/vueuse) at commit
%bench.real.vueuse.commit%: `build` on the whole workspace, 12 tasks.

| Run                     | vx                             | %bench.real.vueuse.rival%         |
| ----------------------- | ------------------------------ | --------------------------------- |
| Cold build (total time) | %bench.real.vueuse.cold.vx%    | %bench.real.vueuse.cold.rival%    |
| Restore from cache      | %bench.real.vueuse.restore.vx% | %bench.real.vueuse.restore.rival% |
| Nothing changed         | %bench.real.vueuse.noop.vx%    | %bench.real.vueuse.noop.rival%    |

Run %bench.real.vueuse.date% on %bench.real.vueuse.machine%, against
%bench.real.vueuse.tool%.

This workspace sets `* text=auto eol=lf`. There Turborepo trusts git's
index, and
[a conformance case](../../conformance/#inputs/same-size-line-ending-swap-under-text-attribute)
shows it replaying stale output after a same-size line-ending change.

vx trusts the index there only for a file whose stored blob is the same
size as the file, which a line-ending conversion never leaves. Every
other file is checked on disk.

## t3-oss/create-t3-turbo

[t3-oss/create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) at
commit %bench.real.create-t3-turbo.commit%: `build` over `./packages/*`,
3 tasks.

| Run                     | vx                                      | %bench.real.create-t3-turbo.rival%         |
| ----------------------- | --------------------------------------- | ------------------------------------------ |
| Cold build (total time) | %bench.real.create-t3-turbo.cold.vx%    | %bench.real.create-t3-turbo.cold.rival%    |
| Restore from cache      | %bench.real.create-t3-turbo.restore.vx% | %bench.real.create-t3-turbo.restore.rival% |
| Nothing changed         | %bench.real.create-t3-turbo.noop.vx%    | %bench.real.create-t3-turbo.noop.rival%    |

Run %bench.real.create-t3-turbo.date% on
%bench.real.create-t3-turbo.machine%, against
%bench.real.create-t3-turbo.tool%.

<!-- bench:end -->

Cold build deletes the outputs and both caches, and is the whole build's
wall time: a real workspace has no ideal schedule to subtract, so the
total is the fair number. Restore deletes the build outputs and keeps
the cache; "nothing changed" deletes nothing. In those two rows every
task is a cache hit, so the whole run is the runner's overhead.

Turborepo runs with its daemon off. Each workspace's vx config, its
pinned commit and every change the bench makes to it live in vx's
source under `private/vx-bench/real/`, and a workflow measures them
again each week. How the harness works is in
[the benchmarks](../../benchmarks/#real-repos).

## Try it on yours

```sh
bunx @vzn/vx init --native
```

`--native` writes a `vx.config.ts` per package from your `turbo.json`
or Nx graph; [Migrate](../../guides/migrate/) walks through it. Run `vx
run build --all` next to the tool you use today.

More workspaces join this page as they are measured, each with its commit,
versions and machine.
