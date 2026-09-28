---
title: 'Why did this re-run?'
date: 2026-09-10T23:47:00Z
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

  what to do:
    file  an edit re-runs by design; a file the task does not read belongs out of cache.inputs.files
```

One component moved and it is named. Forty-one did not.

## What it reads

`vx why` is read-only over the local `cache.db`. It evaluates no
project config (the workspace file, once, for the cache directory,
unless `--cache-dir` names it), re-hashes nothing, runs nothing. It
compares the task's latest recorded run with the one before it (or a
run you pin with `--run`) and diffs the stored components, one row per
kind: `file` (path and blob id), `env` (a declared variable), `runtime`
and `ws-runtime` (a declared command's output, project- or
workspace-rooted), `forward` (the argv forwarded after `--`), `package`
(the project's own `package.json`), `workspace` (the fingerprint),
`config` (the evaluated task config), `upstream` (a dependency's input
key, by task id) and `plugin` (a plugin's material, by name). When
`@vzn/vx-lockfile` is declared, a dependency bump shows up as
`plugin @vzn/vx-lockfile/pnpm` for exactly the projects it reaches.

Because it only reads the database, it works after the fact and on
another machine: a CI job that copied `.vx/cache` out can be asked why
it rebuilt, tomorrow, from a laptop.

## Six endings for an unchanged key

The interesting cases are the ones where the key did *not* change, and
`vx why` distinguishes them rather than calling all six a re-run. The
verdict line is one of these nine sentences, quoted from the code:

| vx says                                                                                                    | What happened                                                    |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| cache key changed between the previous run and this one (inputs differ)                                    | the components are listed                                        |
| cache key unchanged — this run was served from cache, nothing re-ran                                       | it was a cache hit                                               |
| cache key unchanged — the previous run on this key failed and saved nothing, so there was nothing to hit | a failure saves no entry |
| cache key unchanged — re-executed because this run did not read the cache (--force, or a --cache without read) | the run's policy read no cache |
| cache key unchanged — no entry for this key was in the cache when it ran (pruned or evicted), so it executed and saved one | the entry was gone |
| cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)                     | none of the above; vx cannot name the cause |
| cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown                  | the run recorded no outcome for this task; vx says so, not guesses |
| this task declares no `cache` block — it runs on every invocation; its key is folded by dependents only    | not a cache decision at all                                      |
| this task recorded no cache key (skipped, or a persistent task) — nothing to compare | there is no key to compare |

The sixth row ("re-executed on the same key") is the one to read
twice: vx could not name the cause. An undeclared input does not end
up there. A file, env var or tool version the key cannot see changes
the output but not the key, so the task hits and replays stale bytes.
The way to make that impossible is the [sandbox](../the-sandbox/),
which turns the input declaration into a boundary the task cannot
cross.

## The same answer for machines

`--format json` emits one object: `{ taskId, runId, why, diff }`. The
`@vzn/vx-mcp` plugin exposes the same query as a tool a coding agent
can call (`whyDidThisRerun`), so "why is CI rebuilding everything" is a
question an agent can answer without reading the source of the runner.

A cache is a claim that the work has been done before. `vx why` is how
the claim is audited. The guide is
[Caching](../../guides/configure/#why-did-it-re-run).
