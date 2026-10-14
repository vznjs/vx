---
title: 'vx on real repos: wall times'
date: 2026-10-14T22:00:00Z
authors:
  - vzn
tags:
  - benchmarks
  - comparison
excerpt: 'Open-source monorepos that already run on Turborepo or Nx, timed under their own runner and under vx: cold, cache restore, one-file edit and a clean clone. Raw seconds, min of three, slower rows included.'
---

The [synthetic benchmark](../honest-benchmarks/) runs one generated
graph. This post times repos someone else wrote: open-source monorepos
that already use Turborepo or Nx, each moved to native vx config with
`bunx @vzn/vx-migrate --native`, then run under both tools on the same
machine.

Both tools build the same outputs; that is the assumption behind every
row.

## The repos

| Repo | Commit | Rival | Tasks timed |
| --- | --- | --- | --- |
| create-t3-turbo | 8f945b7 | Turborepo 2.5.8 | `build typecheck`, 11 |
| react-email | 1531a39 | Turborepo 2.9.14 | `build`, 4 |
| trpc | d756e59 | Turborepo 2.10.12 | `build`, 7 |
| vercel/ai | e8c8e32 | Turborepo 2.9.14 | `build`, 82 |
| TanStack query | 817bd02 | Nx 23.2.1 | `build`, 25 |
| typescript-eslint | 57e7cccce | Nx 23.2.0 | `build`, 18 |

## Method

- One cloud container: 4 vCPU (Intel Xeon @ 2.10GHz), 15 GB RAM, Linux
  6.18, nothing else running.
- vx built from `main` (d81d9b4) with `bun build --compile` on Bun 1.4.2,
  configs written by `vx-migrate --native` from the same commit, then
  `vx lock`. Node 22.22.0.
- Concurrency 10 for every tool: Turborepo `--concurrency=10`, Nx
  `--parallel=10`, vx `--concurrency 10`.
- Local cache only: no remote cache, no daemon, no telemetry. Nx's
  cache is pinned to one directory with `NX_CACHE_DIRECTORY`.
- Four arms, each tool wiping only its own cache:
  - **cold**: cache and every build output wiped.
  - **restore**: outputs wiped, cache kept.
  - **edit**: one source file gets a new line (new content each rep),
    outputs kept.
  - **clone**: a fresh `git clone` at another path sharing the first
    checkout's cache, with no outputs.
- Three reps. Each rep runs every arm for both tools, and the order
  alternates (the rival first in reps 1 and 3, vx first in rep 2). Each
  cell is the minimum of the three, in seconds. Every run exited 0.

## Results

Seconds, min of 3. Lower is less time.

### create-t3-turbo (Turborepo 2.5.8)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 14.55 | 12.52 |
| restore | 0.31 | 0.12 |
| edit `packages/validators/src/index.ts` | 5.14 | 5.61 |
| clone | 0.32 | 0.12 |

The edit re-ran 4 of 11 under both.

### react-email (Turborepo 2.9.14)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 32.19 | 30.45 |
| restore | 0.34 | 0.27 |
| edit `packages/render/src/shared/options.ts` | 32.77 | 29.81 |
| clone | 0.34 | 0.35 |

The edit re-ran 4 of 4 under both.

### trpc (Turborepo 2.10.12)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 10.65 | 8.86 |
| restore | 0.18 | 0.16 |
| edit `packages/server/src/index.ts` | 10.96 | 8.29 |
| clone | 0.19 | 0.17 |

The edit re-ran 7 of 7 under both.

### vercel/ai (Turborepo 2.9.14)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 174.61 | 155.66 |
| restore | 0.98 | 0.43 |
| edit `packages/provider-utils/src/index.ts` | 166.39 | 149.91 |
| clone | 0.99 | 0.67 |

The edit re-ran 80 of 82 under both.

### TanStack query (Nx 23.2.1)

| Arm | Nx | vx |
| --- | ---: | ---: |
| cold | 39.75 | 33.74 |
| restore | 1.24 | 0.41 |
| edit `packages/query-core/src/index.ts` | 38.52 | 33.57 |
| clone | 1.14 | 0.65 |

The edit re-ran 24 of 25 under both.

Nx's first clone rep missed all 25 tasks (44.16 s) and hit in the other two: Nx 23 indexes its local cache in the checkout's own `.nx/workspace-data`, so a fresh clone sharing the cache directory misses once. The table shows the minimum.

### typescript-eslint (Nx 23.2.0)

| Arm | Nx | vx |
| --- | ---: | ---: |
| cold | 62.54 | 49.13 |
| restore | 5.41 | 5.90 |
| edit `packages/utils/src/index.ts` | 45.21 | 42.86 |
| clone | 4.27 | 6.00 |

The edit re-ran 10 of 18 under Nx, 12 under vx.

Restore and clone hit 17 of 18 under Nx and 15 under vx, which leaves two more tasks uncached. Nx's first clone rep missed all 18 (63.53 s), for the same reason as TanStack query.

vx took longer on four rows: the create-t3-turbo edit, the react-email
clone, and typescript-eslint's restore and clone.

## Run it on yours

```bash
npx @vzn/vx init
npx @vzn/vx run build --all
```

Then time your runner's command and `vx run` on the same machine, each
on its own cache. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
