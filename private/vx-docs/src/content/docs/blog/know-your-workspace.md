---
title: 'One command to know your workspace'
date: 2026-10-09T05:20:00Z
authors:
  - vzn
tags:
  - dx
  - caching
excerpt: 'vx info answers the questions a bug report starts with: versions, projects, workers, memory, cache size, flaky tasks, sandbox. And one command keeps the cache in bounds.'
---

"Which version? How big is the cache? Can this machine sandbox?" Every
bug report starts with those questions, and so does every agent that
lands in a new repository. `vx info` answers them in one screen.

```sh frame="terminal"
$ vx info

─ vx info ────────────────────────────────────────────────────
  vx                0.0.0
  bun               1.4.2
  git               2.43.0
  git status cache  core.fsmonitor, core.untrackedCache off
  projects          4 (8 tasks)
  plugins           none
  workers           4 — the CPU count
  memory            13 GB usable — cgroup limit; the machine has 16 GB
  cache dir         .vx/cache (412 KB, this workspace's run history)
  cache store       ~/.vx/2077a074894d4183/cache (9.8 KB, shared by this repo's checkouts)
  cache versions    keys vx-cache-v43 · index schema v35
  cache entries     41 (9.8 KB)
  task runs (24h)   71 (27 cache hits: 23 up-to-date, 4 restored)
  flaky tasks       none
  sandbox           available (0 tasks declare exec.sandbox)
  projects lock     yes
```

It reads what vx already knows: the run history, the cache index, the
host. It notes when a container caps memory below the machine's, and
whether git's fast status cache is on. `--format json` gives agents the
same facts.

## A cache you keep in bounds

A content-addressed cache only grows, and no run evicts. Trim it by
hand or from a schedule, and look first:

```sh frame="terminal"
$ vx cache clean --max-size 4KB --dry-run
› vx cache clean  would free 5.9 KB (dry run)

  25 entries
```

Learn more: [the CLI reference](../../cli/) and
[the workspace schema](../../schema/).
