---
title: 'Why did this re-run?'
date: 2026-09-10
authors:
  - vzn
tags:
  - dx
  - caching
excerpt: "You changed one file and expected one rebuild; you got twelve. Most tools say 'miss' and stop. vx keeps the per-component fingerprints behind every key, so `vx why` names the component that moved."
---

A cache key is one opaque hash. When it changes, knowing *that* it
changed is nearly useless. You need to know which of its parts moved.
Most tools do not keep that information; they compute the hash, compare
it, and print `miss`. The afternoon you then spend bisecting your own
inputs is the real cost of the cache.

vx records the per-component input fingerprint alongside every cache
entry. That makes the question answerable from the terminal:

```console
$ vx why app#build
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed between the previous run and this one (inputs differ)

  what changed (1 component, 41 unchanged):
    changed file  src/input.txt  3fe2a1b0… → 91c47d22…
```

One component moved and it is named. Forty-one did not.

## What it reads

`vx why` is read-only over the local `cache.db`. It evaluates no
config, re-hashes nothing, runs nothing. It compares the task's latest
recorded run with the one before it (or a run you pin with `--run`) and
diffs the stored components: files by path and blob id, env values by
name, the resolved config hash, the upstream keys by task id, the
workspace fingerprint, a plugin's material by plugin name. When
`@vzn/vx-lockfile` is declared, a dependency bump shows up as
`plugin @vzn/vx-lockfile/pnpm` for exactly the projects it reaches.

Because it only reads the database, it works after the fact and on
another machine: a CI job that copied `.vx/cache` out can be asked why
it rebuilt, tomorrow, from a laptop.

## Three endings for an unchanged key

The interesting cases are the ones where the key did *not* change, and
`vx why` distinguishes them rather than calling all three a re-run:

| Verdict                 | What happened                                                                   |
| ----------------------- | ------------------------------------------------------------------------------- |
| key changed             | Inputs differ. The components are listed.                                       |
| unchanged, served       | It was a cache hit. Nothing re-ran.                                             |
| unchanged, re-executed  | `--no-cache` or `--force`, or something outside the key influenced the run.     |
| no cache outcome        | The run recorded nothing for this task, and vx says so instead of guessing.     |

The third row is the one to act on. If a task re-executed on an
unchanged key and you did not ask it to, something the key cannot see
is steering the build: an undeclared file, an env var under
`passThrough` instead of `inputs.env`, a tool version you never listed.
The way to make that impossible is the [sandbox](../the-sandbox/),
which turns the input declaration into a boundary the task cannot
cross.

## The same answer for machines

`--format json` emits one object: `{ taskId, runId, why, diff }`. The
`@vzn/vx-mcp` plugin exposes the same query as a tool a coding agent
can call (`whyDidThisRerun`), so "why is CI rebuilding everything" is a
question an agent can answer without reading the source of the runner.

A cache is a claim that the work has been done before. `vx why` is how
the claim is audited. The guide is [Trusting the
cache](../../guides/trusting-the-cache/).
