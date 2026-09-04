---
title: Trusting the cache
description: Why a cache hit re-ran when you expected one — vx why reads the key components behind a task hash.
---

A cache is a claim: *this work has already been done, and replaying it
gives the same result.* The question that follows, and that most build
tools cannot answer: **why did this re-run?** You changed one file and
expected one rebuild; you got twelve. The tool says `miss` and stops
there.

vx has a verb for that question, and a way to confine what a task may
read so the claim stays true.

## `vx why` — what moved the key

A cache key is one opaque hash. When it changes, knowing *that* it
changed is useless; you need to know **which component** changed. vx
records the per-component input fingerprint alongside every entry, so it
can answer directly:

```bash
vx why app#build
```

```console
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed between the previous run and this one (inputs differ)

  what changed (1 component, 41 unchanged):
    changed  file  src/index.ts  a1b2c3… → d4e5f6…
```

The useful part is the last line: **one** component moved, and it is
named. Forty-one didn't. That turns "why is CI rebuilding everything"
from an afternoon into a question with an answer.

It reads only the local database — no config evaluation, no re-hashing,
no execution — so it is safe to run anywhere, including after the fact
on a machine that just cloned the cache.

An unchanged key has three different endings, and `vx why` distinguishes
them rather than calling them all a re-run:

| Verdict                     | What happened                                              |
| --------------------------- | ---------------------------------------------------------- |
| key changed                 | inputs differ — the components are listed                   |
| unchanged, served           | it was a cache hit; nothing re-ran                          |
| unchanged, re-executed      | `--no-cache` / `--force`, or something outside the key      |

That last row is the interesting one: if a task re-executes on an
*unchanged* key and you didn't ask it to, something is influencing the
build that the key cannot see. Which is the next section.

## Keeping the claim true

A stale hit is the dangerous failure: it replays outputs from a build
whose inputs are gone, under a green check, and nothing downstream can
tell. The way vx keeps that from happening is the declaration itself —
inputs are explicit, never inferred — plus a boundary for tasks that
need one. A task with a [`sandbox`](../sandboxing/) block runs with the
paths it declared as the only ones it can read, so a read it never
declared fails then and there instead of quietly aging into a wrong
cache entry.

Use `vx why` whenever a run surprises you. Sandbox the tasks whose
inputs you are least sure of.

If you want the mechanics rather than the usage:

- [Caching deep dive](../../caching/) — exact key derivation, what's in
  the key and what deliberately isn't.
- [CLI reference](../../cli/) — every flag and its failure modes.
- [Sandboxing tasks](../sandboxing/) — the per-task `sandbox` block:
  what it allows, what it denies, and what it reports.
