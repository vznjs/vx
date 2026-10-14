---
title: 'vx lock: freezing what the key sees'
date: 2026-09-10T23:44:00Z
authors:
  - vzn
tags:
  - config
  - ci
excerpt: "Configs are programs and programs can read the environment. `vx lock` evaluates every config now and writes the resolved objects to a lockfile; every `vx run` uses them without evaluating; `vx lock --check` catches drift a byte hash cannot see."
---

A TypeScript config buys composition and costs one guarantee: what it
evaluates to can depend on where it is evaluated. `process.env.CI`,
a `Date`, an import that resolved differently on another machine. On a
laptop that is fine. In a pipeline that must run exactly the config a
reviewer approved, it is a hole.

`vx lock` closes it the way package managers closed the same hole for
dependencies.

## Three verbs

```bash
vx lock              # evaluate every vx.config.* now; write .vx/projects.lock.json
vx lock --check      # audit: full re-evaluation against the lock; exit 1 on drift
vx run …             # consume the lock; no evaluation at all
```

`vx lock` evaluates each config in the current environment and stores
the post-evaluation object under the project's name. It also checks the
graph rules. It is the only verb that writes the lock.

Every `vx run`, `vx watch` cycle, `--affected` selection and the picker
reads configs **only** from the lock. A run never evaluates a config,
never checks the rules and has no staleness check of its own: a
config's env reads keep their lock-time values, and a project absent
from the lock is a hard error. With no lock a run stops with
`` no lock: run `vx lock` ``. Edit a config, run `vx lock`. A project
with no `vx.config.*` (its tasks from a plugin's `project` stage, such
as `turbo()`) has nothing to lock and gets its tasks live on every
run.

## The check that a hash cannot do

`--check` re-evaluates every config in the current environment and
compares the result to the frozen object. That catches an edit, and
what an edit-detector cannot: an env value read at evaluation time that
differs from the lock's, an imported preset that changed, a computed
command whose input moved. Every mismatched project is listed
on stderr and the exit code is 1.

The CI recipe is two lines:

```bash
vx lock --check && vx run ci --all
```

The first line proves the lock still describes the configs as this
machine would evaluate them. The second runs exactly the lock. A pull
request that changes a config without re-running `vx lock` fails the
first line, which is the point.

## What the lock is not

- **Not a cache key input.** `.vx/projects.lock.json` is excluded from every
  task's input set and from the workspace fingerprint, so running `vx
  lock` does not re-key the workspace.
- **Not a substitute for `cache.inputs.env`.** The lock freezes what a
  config *evaluated to*. An env var a task reads at run time is still a
  run-time input and belongs under `cache.inputs.env`, where it joins
  the key. The two mechanisms are parallel on purpose: config-time
  values are locked, run-time values are keyed.
- **Not a performance feature first.** A run reads its configs from the
  lock and evaluates none; the lock is about determinism, and the
  milliseconds it saves are incidental.

## For agents

An agent asks the same question in JSON: `vx lock --check --format json`
prints `{"upToDate": false, "audited": 4, "notAudited": 0, "problems": [...]}`
with the same exit code. Each
problem is the line a person would read on stderr.

## Where it came from

The lock exists because the resolved-config hash made configs
powerful, and power needs an audit. Package managers learned the same
lesson with `--frozen-lockfile`. vx goes one step further: resolution
happens only in `vx lock`, and every run is pinned to its result. The
design note is in the repository under `docs/design/config-lock`; the
reference is [`vx lock`](../../cli/#vx-lock).
