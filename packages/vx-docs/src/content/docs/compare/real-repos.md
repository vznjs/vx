---
title: vx on real repos
description: Public monorepos moved to vx and timed against the tool they ship with, with the commit, versions and machine for every number.
---

The benchmark on [vx vs Nx](../nx/) is a synthetic graph built to be
fair to every tool. This page is the other half: real public repos, moved
to vx with one command and timed against the tool they already use.

Covered so far: TanStack/query (Nx), create-t3-turbo and react-email
(Turborepo). The list grows as runs finish.

## TanStack/query, against Nx

[TanStack/query](https://github.com/TanStack/query) at commit `817bd02`,
the `build` tasks without examples and integrations: 25 tasks for each
tool.

| Run                     | vx         | Nx     | vx is       |
| ----------------------- | ---------- | ------ | ----------- |
| Cold build (total time) | **34.6 s** | 39.4 s | 14% faster  |
| Restore from cache      | **0.39 s** | 1.26 s | 3.2× faster |
| Nothing changed         | **0.22 s** | 1.43 s | 6.5× faster |

Cold build deletes the outputs and both caches, and is the whole
build's wall time: on a real repo there is no ideal schedule to
subtract, so the total is the fair number. Restore deletes the build
outputs and keeps the cache; "nothing changed" deletes nothing. In
those two rows every task is a cache hit, so the whole run is the
runner's overhead. "N× faster" means Nx takes N times as long, "N%
faster" N% longer.

Run 2026-10-09 on linux x64, 4 cores: vx 0.0.633 configured by
`vx init --native`, Nx 23.2.1 with the daemon off and no Nx Cloud, pnpm
12.4.2. 5 workers each, best of three interleaved runs. Every run is in
[the benchmarks](../../benchmarks/#real-repos).

## create-t3-turbo and react-email, against Turborepo

[t3-oss/create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) at
commit `8f945b7` (3 tasks) and
[resend/react-email](https://github.com/resend/react-email) at commit
`1531a39` (7 tasks), the `./packages/*` tasks, each against the
Turborepo version the repo pins.

| Run                          | vx          | Turborepo | vx is       |
| ---------------------------- | ----------- | --------- | ----------- |
| create-t3-turbo, cold build  | **6.23 s**  | 7.14 s    | 15% faster  |
| create-t3-turbo, restore     | **0.087 s** | 0.519 s   | 6.0× faster |
| create-t3-turbo, nothing new | **0.081 s** | 0.476 s   | 5.9× faster |
| react-email, cold build      | **30.21 s** | 33.22 s   | 10% faster  |
| react-email, restore         | **0.283 s** | 0.382 s   | 35% faster  |
| react-email, nothing new     | **0.136 s** | 0.252 s   | 85% faster  |

Cold build is the total wall time from empty caches; restore and
nothing new are cache hits throughout, so they are the runner's
overhead. "N% faster" means Turborepo takes N% longer.

Run 2026-10-09 on linux x64, 4 cores: vx 0.0.634 configured by
`vx init --native` plus the
[history scheduler](../../plugins/vx-schedule-history/) reading task
timings saved from one earlier run; Turborepo 2.5.8 (create-t3-turbo)
and 2.9.14 (react-email) with the daemon off; pnpm 12.4.2. 10 workers
each, best of three interleaved runs. Every run is in
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
