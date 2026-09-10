---
title: 'Cascade through dependencies by folding input keys, never outputs'
date: 2026-09-10
authors:
  - vzn
tags:
  - caching
  - internals
excerpt: "When a library changes, its dependents must re-key. There are two ways to carry that change downstream, and vx tried both. It settled on the one that lets every key in the graph be known before anything runs."
---

A monorepo cache has to propagate change. Edit `packages/ui/src/button.tsx`
and `apps/web#build` must miss, even though nothing under `apps/web`
changed. The mechanism for that is the tenth part of the
[key derivation](../keys-from-git/): every upstream task's key is
folded into its dependents' keys. The question is *which* upstream
hash gets folded.

## Two designs

**Output-based cascade** (also called early cutoff): fold the hash of
the upstream task's *outputs*. If `ui#build` re-ran but produced
byte-identical `dist/`, the downstream key is unchanged and `web#build`
hits. Attractive: a whitespace-only edit in a library does not rebuild
the app.

**Input-based cascade**: fold the upstream task's *input key*. If
anything `ui#build` depends on changed, `web#build` re-keys, whether or
not the output moved.

vx shipped early cutoff in one cache version and reverted it in the
next. The reason is not that it was wrong. It is that it makes the key
unknowable at the moment the key is most useful.

## Keys before execution

With input-based cascade, every key in the graph is a pure function of
the working tree, the configs and the environment. All of them can be
derived up front, before a single task starts, and that is the property
almost everything else in vx is built on:

- **`vx run --dry`** prints the real key and the real hit/miss status
  for every task without executing anything. Under early cutoff, a
  downstream key does not exist until its upstream has run.
- **Remote prefetch** issues the lookups for the whole graph at once
  and lets network latency overlap with real work instead of sitting on
  the critical path. It needs the keys first.
- **The restore tier** of the scheduler classifies every stable task as
  a hit or a miss up front, makes the hits ready immediately at low
  priority, and lets misses own the worker pool while restores backfill
  idle capacity. Measured at −6.6% on a mixed workload. It needs the
  keys first.
- **Remote execution** ships a task to a worker as one self-contained
  action whose inputs are exactly what the key declares. The action
  digest is the key's cousin; it must be computable without running the
  upstream locally.
- **`vx why`** can explain a change as a diff of named components,
  because a component is an input, and inputs have names.

Early cutoff trades all of that for the whitespace-edit case. In
practice that case is rare, cheap (the downstream task runs once, and
its own output is then cached under the new key) and, when it matters,
better handled by declaring narrower inputs so the whitespace edit is
not an input at all.

## What "pure input" means precisely

A dependent's key folds the upstream's key, which is itself pure
input. The fold is transitive through the graph, so `web#build` carries
the keys of everything it can reach, and an edit anywhere in that
closure moves it. The fold is also *filtered*: only the upstreams the
graph actually connects are folded, so an unrelated package's edit does
not move it.

There is one subtlety the scheduler is careful about. A task whose
input globs could match a same-project upstream's declared outputs (a
`test` task reading `dist/**` produced by `build`) has a key that is
technically pure but *preliminary*: the files it reads are the upstream's
outputs, which may not exist yet. Such a task stays gated on its
dependencies and is excluded from the up-front probe. The rule that
finds it is shared between the local restore tier and remote prefetch,
so the two cannot disagree about which keys are stable.

Full derivation and every version's reason: [Caching](../../caching/).
