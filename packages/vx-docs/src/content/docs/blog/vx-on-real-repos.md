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
`vx init`, then run under both tools on the same machine.

Both tools build the same outputs; that is the assumption behind every
row.

## The repos

| Repo | Commit | Rival | Tasks timed |
| --- | --- | --- | --- |
| create-t3-turbo | 8f945b7 | Turborepo 2.5.8 | `build typecheck`, 11 |
| vercel/ai | e8c8e32 | Turborepo 2.9.14 | `build`, 82 |
| typescript-eslint | 57e7cccce | Nx 23.2.0 | `build`, 18 |

## Method

- One cloud container: 4 vCPU (Intel Xeon @ 2.10GHz), 15 GB RAM, Linux
  6.18, nothing else running.
- vx built from `main` (d81d9b4) with `bun build --compile` on Bun 1.4.2,
  configs from `vx init`, then `vx lock`. Node 22.22.0.
- Concurrency 10 for vx and Turborepo; Nx at `--parallel=5`.
- Local cache only for both tools: no remote cache, no daemon, no
  telemetry.
- Four arms, each tool wiping only its own cache:
  - **cold**: cache and every build output wiped.
  - **restore**: outputs wiped, cache kept.
  - **edit**: one source file gets a new line, outputs kept.
  - **clone**: a fresh `git clone` at another path sharing the first
    checkout's cache, with no outputs.
- Three reps. Each rep runs every arm for both tools, and the order
  alternates (the rival first in reps 1 and 3, vx first in rep 2). Each
  cell is the minimum of the three, in seconds.

## Results

Seconds, min of 3. Lower is less time.

### create-t3-turbo (Turborepo 2.5.8)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 14.55 | 12.52 |
| restore | 0.31 | 0.12 |
| edit `validators/src/index.ts` (4 of 11 re-run) | 5.14 | 5.61 |
| clone | 0.32 | 0.12 |

### vercel/ai (Turborepo 2.9.14)

| Arm | Turborepo | vx |
| --- | ---: | ---: |
| cold | 174.61 | 155.66 |
| restore | 0.98 | 0.43 |
| edit `provider-utils/src/index.ts` (80 of 82 re-run) | 166.39 | 149.92 |
| clone | 0.99 | 0.67 |

### typescript-eslint (Nx 23.2.0)

| Arm | Nx | vx |
| --- | ---: | ---: |
| cold | 63.82 | 49.04 |
| restore | 5.45 | 5.75 |
| edit | 47.84 | 46.09 |
| clone | 4.65 | 6.61 |

On typescript-eslint, Nx's first clone rep missed all 18 tasks
(64.2 s) and hit in the other two; the minimum shows the hit.

## Run it on yours

```bash
npx @vzn/vx init
npx @vzn/vx run build --all
```

Then time your runner's command and `vx run` on the same machine, each
on its own cache. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
