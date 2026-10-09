---
title: vx on real repos
description: Public monorepos moved to vx and timed against the tool they ship with, with the commit, versions and machine for every number.
---

The benchmark on [vx vs Nx](../nx/) is a synthetic graph built to be
fair to every tool. This page is the other half: real public repos, moved
to vx with one command and timed against the tool they already use.

Covered so far: TanStack/query (Nx). The list grows as runs finish.

## TanStack/query, against Nx

[TanStack/query](https://github.com/TanStack/query) at commit `817bd02`,
the `build` tasks without examples and integrations: 25 tasks for each
tool.

| Runner overhead          | vx         | Nx     | vx is       |
| ------------------------ | ---------- | ------ | ----------- |
| Restore from cache       | **0.39 s** | 1.26 s | 3.2× faster |
| Nothing changed          | **0.22 s** | 1.43 s | 6.5× faster |

Every task is a cache hit in both rows, so the whole run is the
runner's overhead. Restore deletes the build outputs and keeps the
cache; "nothing changed" deletes nothing. "N× faster" means Nx takes N
times as long.

Run 2026-10-09 on linux x64, 4 cores: vx 0.0.633 configured by
`vx init --native`, Nx 23.2.1 with the daemon off and no Nx Cloud, pnpm
12.4.2. 5 workers each, best of three interleaved runs. Every run is in
[the benchmarks](../../benchmarks/#real-repos).

## Try it on yours

```sh
npm install -D @vzn/vx
npx vx init --keep
```

`--keep` writes one file, `vx.workspace.ts`, which reads your
`turbo.json` or Nx graph as it is: nothing in the repo changes. Run
`vx run build --all` next to the tool you use today. To undo, delete
`vx.workspace.ts`. When you want native config, `vx init --native`
writes a `vx.config.ts` per package; [Migrate](../../guides/migrate/)
walks through it.

More repos join this page as they are measured, each with its commit,
versions and machine.
