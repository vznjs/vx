---
title: 'vx on real repos: wall times'
date: 2026-10-15T10:20:00Z
authors:
  - vzn
tags:
  - benchmarks
  - comparison
excerpt: 'Seven open-source monorepos that already run on Turborepo or Nx, timed under their own runner and under vx: cold, cache restore, one-file edit and a clean clone. Raw seconds, min of three, slower rows included.'
---

The [synthetic benchmark](../honest-benchmarks/) runs one generated
graph. This post times repos someone else wrote: open-source monorepos
that already use Turborepo or Nx, each moved to native vx config, then
run under both tools on the same machine.

Both tools build the same outputs; that is the assumption behind every
row.

## Method

- One cloud container: 4 vCPU (Intel Xeon @ 2.10GHz), 15 GB RAM, Linux,
  nothing else running. Bun 1.4.2, Node 22.22.0.
- vx built from `main` with `bun build --compile`: 522c23b for
  create-t3-turbo, react-email, trpc and typescript-eslint; 731cf92 for
  vercel/ai, medusa and TanStack query; 1ee058c for the react-email clone
  row.
- Configs written by `bunx @vzn/vx-migrate --native --no-install`, then
  `vx lock`.
- Concurrency 10 for every tool: Turborepo `--concurrency=10`, Nx
  `--parallel=10`, vx `--concurrency 10`.
- Local cache only: no remote cache, no daemon, no telemetry.
- Four arms, each tool wiping only its own cache:
  - **cold**: cache and every build output wiped.
  - **restore**: outputs wiped, cache kept.
  - **edit**: one source file gets a new line (new content each rep),
    outputs kept.
  - **clone**: a fresh `git clone` at another path, `node_modules`
    copied, sharing the first checkout's cache, with no outputs.
- Three reps, the order alternating between tools. Each cell is the
  minimum of the three, in seconds. Every run exited 0.

## Results

Seconds, min of 3. Shorter bars are less time; each chart keeps its table one click away.

### create-t3-turbo vs Turborepo 2.5.8

`build typecheck`, 11 tasks, commit 8f945b7.

| Arm | Turborepo 2.5.8 | vx |
| --- | ---: | ---: |
| cold | 13.63 s | 10.97 s |
| restore | 0.28 s | 0.09 s |
| edit | 4.89 s | 4.53 s |
| clone | 0.28 s | 0.11 s |

:::tip[Edit row: `cache.outputs.clean: false`]
By default vx deletes a task's declared outputs before it runs on a miss,
so nothing stale reaches the cache. Here that includes tsc's
`.cache/tsbuildinfo.json`, so tsc rebuilds `api` from scratch: 4.58 s
Turborepo, 4.77 s vx.

With `cache: { outputs: { clean: false } }` in `.vx/workspace.ts`, tsc
keeps its build info and vx caches whatever the outputs hold. Both edit
cells above come from that rerun (vx main f094a70, after 0.0.637; same
machine shape, min of 3).
:::

### react-email vs Turborepo 2.9.14

`build`, 4 tasks, commit 1531a39.

| Arm | Turborepo 2.9.14 | vx |
| --- | ---: | ---: |
| cold | 28.92 s | 25.11 s |
| restore | 0.32 s | 0.22 s |
| edit | 28.23 s | 26.29 s |
| clone | 0.34 s | 0.26 s |

### trpc vs Turborepo 2.10.12

`build`, 7 tasks, commit d756e59.

| Arm | Turborepo 2.10.12 | vx |
| --- | ---: | ---: |
| cold | 9.29 s | 7.48 s |
| restore | 0.17 s | 0.15 s |
| edit | 9.40 s | 7.04 s |
| clone | 0.16 s | 0.13 s |

### vercel/ai vs Turborepo 2.9.14

`build`, 82 tasks, commit e8c8e32.

| Arm | Turborepo 2.9.14 | vx |
| --- | ---: | ---: |
| cold | 144.96 s | 135.33 s |
| restore | 0.92 s | 0.45 s |
| edit | 156.38 s | 145.61 s |
| clone | 0.97 s | 0.65 s |

### medusa vs Turborepo 1.13.4

`build build:plugin`, 83 tasks, commit 5018ab67.

| Arm | Turborepo 1.13.4 | vx |
| --- | ---: | ---: |
| cold | 316.57 s | 307.81 s |
| restore | 3.56 s | 3.45 s |
| edit | 268.92 s | 259.96 s |
| clone | 2.59 s | 3.54 s |

:::note[Clone row]
vx's clone takes what its restore takes (3.54 s and 3.45 s, all 83 hits).
Turborepo's clone takes less time than its own restore.
:::

### TanStack query vs Nx 23.2.1

`build`, 25 tasks, commit 817bd02.

| Arm | Nx 23.2.1 | vx |
| --- | ---: | ---: |
| cold | 35.01 s | 29.37 s |
| restore | 0.94 s | 0.32 s |
| edit | 34.10 s | 29.03 s |
| clone | 0.96 s | 0.58 s |

:::note[Clone row]
Nx's first clone rep missed its cache (36.42 s): Nx 23 indexes its local
cache in the checkout's own `.nx/workspace-data`. The chart shows the
minimum.
:::

### typescript-eslint vs Nx 23.2.0

`build`, 18 tasks, commit 57e7cccce.

| Arm | Nx 23.2.0 | vx |
| --- | ---: | ---: |
| cold | 52.50 s | 41.77 s |
| restore | 4.45 s | 5.32 s |
| edit | 40.69 s | 38.97 s |
| clone | 4.15 s | 5.37 s |

:::note[Restore and clone rows]
vx hits 16 of 18, Nx 17. `ast-spec#build` stays a miss by design: its
inputs include committed snapshots its own test may rewrite, and vx never
keys a task on files another task in the run can write.

Nx's first clone rep missed its cache (56.82 s), as with TanStack query.
:::

## Run it on yours

```bash
npx @vzn/vx init
npx @vzn/vx run build --all
```

Then time your runner's command and `vx run` on the same machine, each
on its own cache. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
