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

Seven open-source monorepos that already use Turborepo or Nx, each moved
to native vx config and timed under both on one machine. Slower rows
included.

```mermaid
flowchart LR
  C[cold: no cache, no outputs] --> R[restore: cache kept, outputs wiped]
  R --> E[edit: one file changed]
  E --> K[clone: fresh checkout, shared cache]
```

<small>4 vCPU Xeon 2.10GHz, 15 GB, Linux · Bun 1.4.2, Node 22.22.0 · vx 522c23b (create-t3-turbo, react-email, trpc, typescript-eslint), 731cf92 (vercel/ai, medusa, TanStack query), 1ee058c (react-email clone) · configs from `bunx @vzn/vx-migrate --native --no-install` · concurrency 10 for all · local cache only, no daemon · 3 reps alternating, min shown, every run exit 0</small>

Seconds, min of 3. Shorter bars are less time; each table is one click
away.

### create-t3-turbo vs Turborepo 2.5.8

`build typecheck`, 11 tasks, commit 8f945b7.

| Arm | Turborepo 2.5.8 | vx |
| --- | ---: | ---: |
| cold | 13.63 s | 10.97 s |
| restore | 0.28 s | 0.09 s |
| edit | 4.69 s | 4.89 s |
| edit, clean: false | 4.61 s | 3.83 s |
| clone | 0.28 s | 0.11 s |

Both edit rows: vx 5b2b0a1, same machine, min of 3. By default vx
deletes a task's outputs before a miss, tsc's `tsbuildinfo` too, so tsc
rebuilds from scratch.

`cache.outputs.clean: false` on the three tsc tasks keeps it.

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
vx hits 16 of 18, Nx 17. `ast-spec#build` stays a miss: its own test
may rewrite its committed snapshots, and vx never trusts a key on files
another task can write.

Nx's first clone rep missed its cache (56.82 s), as with TanStack query.
:::

## Run it on yours

```bash
bunx @vzn/vx init
vx run build --all
```

Then time your runner's command and `vx run` on the same machine, each
on its own cache. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
