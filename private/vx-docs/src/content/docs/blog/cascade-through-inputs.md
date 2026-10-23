---
title: 'Cascade through dependencies by folding input keys, never outputs'
date: 2026-09-10T23:52:00Z
authors:
  - vzn
tags:
  - caching
  - internals
excerpt: "When a library changes, its dependents must re-key. There are two ways to carry that change downstream, and vx tried both. It settled on the one that lets every key in the graph be known before anything runs."
---

`packages/c#build` depends on `packages/a#build`. Add a comment to
`a`:

```sh frame="terminal"
$ echo "// only a comment" >> packages/a/src/index.ts
$ vx run build --all
 ⏺︎     9ms success miss     packages/a#build
 ⏺︎     8ms success miss     packages/c#build

$ cmp packages/a/dist/index.js /tmp/a-before.js && echo identical
identical

$ vx why packages/c#build
  verdict    cache key changed: upstream packages/a#build
  what changed (1 component, 5 unchanged):
    changed upstream  packages/a#build  8d4c5d7e6e657a9c → 234db6b6c1ccd2b1
```

`a`'s bundle came out byte-identical, and `c` still re-ran. That is on
purpose: `c`'s key folds `a`'s **input** key, not its output (part ten
of the [key derivation](../keys-from-git/)). Demo
workspace, vx at `69617eb`, 2026-10-23.

## Two designs

| Fold the upstream's…        | A comment-only edit upstream | Key known before anything runs? |
| --------------------------- | ---------------------------- | ------------------------------- |
| output hash (early cutoff)  | downstream hits              | no: needs the upstream to run   |
| input key (vx)              | downstream re-runs once      | yes                             |

vx shipped early cutoff in one cache version and reverted it in the
next. It isn't wrong. It makes the key unknowable when the key is most
useful.

## Keys before execution

With input keys, every key in the graph is a pure function of the tree,
the configs and the environment, so all of them exist before a task
starts:

```sh frame="terminal"
$ echo "// again" >> packages/a/src/index.ts
$ vx run build --all --dry
  ▶  packages/a#build  cache miss — would exec   8844b0fc  ~9ms
  ✓  packages/b#build  cache hit (local)         e8c0e9d5
  ▶  packages/c#build  cache miss — would exec   1c43f07c  ~10ms
  ✓  packages/d#build  cache hit (local)         9f1cef08
```

`c`'s new key is there before `a` has run. Much of vx stands on that:

- **`vx run --dry`** prints real keys and real hit/miss, as above.
- **Remote prefetch** asks for the whole graph at once, and only for
  keys the local cache lacks.
- **The restore tier** sorts every stable task into hit or miss up
  front, so misses own the workers while restores fill idle slots.
- **Remote execution** ships a task as one action whose digest must be
  computable without running its upstream locally.
- **`vx why`** names what changed, because each component is a named
  input.

The price is the case above: one extra run downstream, whose output is
then cached under the new key. When it matters, narrower inputs keep
the edit out of the key entirely.

## What "pure input" means precisely

A dependent's key folds the upstream's key, which is itself pure
input. The fold is transitive through the graph, so `web#build` carries
the keys of everything it can reach, and an edit anywhere in that
closure moves it. The fold is also *filtered*: only the upstreams the
graph actually connects are folded, so an unrelated package's edit does
not move it.

There is one subtlety the scheduler is careful about. A key is
technically pure but *preliminary* when an upstream may write a file
the task reads before it runs, so the bytes it hashed up front are not
the ones it will read: an upstream's root-anchored
`outputs.workspaceFiles`, an upstream with no `cache` block that may
write in the project, or a cached upstream that rewrites its own inputs
in place (a formatter) whose key this one does not fold. Such a task,
and every task depending on it, stays gated on its dependencies and is
excluded from the up-front probe. A task whose input globs can match
another task's declared outputs (a `test` task reading `dist/**`
produced by `build`) is refused by `vx lock`, so its key can never be
preliminary by accident. The one exception is a dependency the reader's
key does not fold (left out of `inputs.tasks`): its key waits for that
dependency and hashes the bytes it wrote. The rule
that finds it is shared between the local restore tier and remote
prefetch, so the two cannot disagree about which keys are stable.

Full derivation: [Caching](../../caching/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
