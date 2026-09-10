---
title: 'vx lock: freezing what the key sees'
date: 2026-09-10T23:44:00Z
authors:
  - vzn
tags:
  - config
  - ci
excerpt: "Configs are programs and programs can read the environment. `vx lock` evaluates every config now and writes the resolved objects to a lockfile; `vx run --frozen` uses them without evaluating; `vx lock --check` catches drift a byte hash cannot see."
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
vx lock              # evaluate every vx.config.* now; write vx-lock.json
vx lock --check      # audit: hashes + full re-evaluation against the lock; exit 1 on drift
vx run … --frozen    # consume the lock; no evaluation at all
```

`vx lock` evaluates each config in the current environment and stores
the post-evaluation object plus a content hash of the config file.
Plain runs **always** evaluate live; the lock's existence changes
nothing about `vx run`. Only `--frozen` consumes it, and under
`--frozen` there is no evaluation and no staleness check of its own: a
config's env reads keep their lock-time values, a project absent from
the lock is a hard error, a missing lock is a hard error.

## The check that a hash cannot do

`--check` does two things, and the second is the reason the verb
exists. It compares the stored content hash of each config file, which
catches an edit. Then it re-evaluates every config in the current
environment and compares the result to the frozen object, which
catches what an edit-detector cannot: an env value read at evaluation
time that differs from the lock's, an imported preset that changed, a
computed command whose input moved. Every mismatched project is listed
on stderr and the exit code is 1.

The CI recipe is two lines:

```bash
vx lock --check && vx run ci --all --frozen
```

The first line proves the lock still describes the configs as this
machine would evaluate them. The second runs exactly the lock. A pull
request that changes a config without re-running `vx lock` fails the
first line, which is the point.

## What the lock is not

- **Not a cache key input.** `vx-lock.json` is excluded from every
  task's input set and from the workspace fingerprint, so running `vx
  lock` does not re-key the workspace.
- **Not a substitute for `cache.inputs.env`.** The lock freezes what a
  config *evaluated to*. An env var a task reads at run time is still a
  run-time input and belongs under `cache.inputs.env`, where it joins
  the key. The two mechanisms are parallel on purpose: config-time
  values are locked, run-time values are keyed.
- **Not a performance feature.** Evaluation is already cheap and cached
  where it is provably pure. `--frozen` is about determinism, and the
  milliseconds it saves are incidental.

## Where it came from

The lock exists because the resolved-config hash made configs
powerful, and power needs an audit. Package managers learned the same
lesson with `--frozen-lockfile`: let resolution be dynamic in
development and pin it where reproducibility is the contract. The
design note is in the repository under `docs/design/config-lock`; the
reference is [`vx lock`](../../cli/#vx-lock).
