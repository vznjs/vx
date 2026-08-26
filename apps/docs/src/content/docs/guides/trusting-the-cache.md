---
title: Trusting the cache
description: Why a cache hit re-ran when you expected a hit, and how to prove a hit is safe — vx why, --verify, and the CI recipes that make both routine.
---

A cache is a claim: *this work has already been done, and replaying it
gives the same result.* Two questions follow from that claim, and most
build tools can answer neither.

1. **"Why did this re-run?"** You changed one file and expected one
   rebuild; you got twelve. The tool says `miss` and stops there.
2. **"Can I trust this hit?"** Nothing re-ran, the run went green — but
   is the restored output really what a fresh build would have
   produced?

The second is the dangerous one. A stale hit doesn't fail: it replays
outputs from a build whose inputs are gone, under a green check, and
nothing downstream can tell. It's the only bug class where "it passed"
is the symptom.

vx has a verb for each question.

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

## `--verify` — proving the hit is safe

`vx why` explains the past. `--verify` tests the claim. It comes in
three modes, and they answer genuinely different questions.

### `--verify=determinism` — does this task produce the same bytes twice?

Runs the task, then runs it **again**, and compares the outputs
byte-for-byte.

```bash
vx run build --verify=determinism
```

A task that fails this is not safe to cache at all — an embedded
timestamp, a hash-seed, a directory-order dependency — and the failure
is *loud* rather than a slow drift into confusing hits. Disk is left
byte-identical to the cached artifact either way, so a failed proof
never leaves you with a half-written tree.

### `--verify=inputs` — did the task read something it didn't declare?

This is the one that catches the stale-hit class before it can happen.

vx never guesses your inputs by tracing filesystem reads — a traced set
describes what the task read *that time, on that machine*, and can't be
known before the run, which is exactly when the key is needed. So vx
asks you to declare inputs, and then lets you **prove the declaration**:

```bash
vx run build --verify=inputs
```

The task runs under an OS sandbox scoped to its declared inputs. A read
of a workspace file it never declared is reported as
`undeclared-inputs` and **reds the run**. Zero violations is a proof —
recorded as `proven-complete`, not an assumption.

That undeclared file is precisely the thing that would have produced a
stale hit later: it affects the output, it isn't in the key, so a change
to it wouldn't invalidate anything.

### `--verify=fingerprint` — the cross-machine check

The one failure a single machine cannot see: two machines producing
*different* outputs for the same key. This mode fingerprints each
executed task's outputs by content and emits them, so a CI job on Linux
and one on macOS can be compared.

```bash
vx run --all --force --verify=fingerprint
```

Use `--verify=all` to run the input-completeness proof and the
determinism proof together.

## Making it routine

Verification costs a re-run, so it doesn't belong on every build. The
shape that works:

- **Developers run nothing special.** The ordinary `vx run` is the fast
  path.
- **A nightly or pre-release job runs `--verify=all --force`** across the
  workspace. It's the job that would have caught the problem weeks
  before anyone noticed a wrong artifact.
- **`vx why` on demand**, whenever a run surprises you.

The verdict rides your telemetry too, so if you've declared
[`@vzn/vx-otel`](../otel-bridge/) or
[`@vzn/vx-github`](../ci/) the proof shows up in traces and the job
summary alongside everything else — you don't have to read CI logs to
find out a proof failed.

## The design behind it

Verification is a pure side-channel: `--verify` is never folded into a
cache key, so a verified run and an ordinary run share the same entry. A
proof costs an extra execution, never a colder cache.

If you want the mechanics rather than the usage:

- [Caching deep dive](../../caching/) — exact key derivation, what's in
  the key and what deliberately isn't.
- [CLI reference](../../cli/) — every flag and its failure modes.
- [Sandboxing tasks](../sandboxing/) — the sandbox `--verify=inputs`
  borrows, available on its own as a per-task setting.
