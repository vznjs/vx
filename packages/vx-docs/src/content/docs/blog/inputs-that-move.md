---
title: 'When an input moves mid-run, vx keeps the result and skips the save'
date: 2026-10-12T17:40:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'A cache key describes the inputs at the moment it was taken. If one changes while the command runs, the output was built from something the key does not name. vx keeps your result, saves no entry, and names the file. Now on CI too.'
---

A cache key is a promise: these outputs were built from exactly these
inputs. vx takes the key just before the command runs. If an input
changes while the command is running, the output was built from bytes the
key does not describe, and filing it under that key would replay the
wrong output on the next hit.

So when an input moves mid-run, vx keeps the run's result, saves no
entry, and tells you which file moved:

```
[vx] app#build: `packages/app/src/routes.gen.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs
```

The next run is a miss and builds again from what is on disk now.

## How it notices

After the command, vx checks each input once. It stats the file, and any
file touched after its digest was learned is hashed again and compared. A
file that is gone has moved. A file added under an input glob since the
listing (a new match the declaration would have picked up) withholds the
save the same way. On a miss that saves, this costs one `lstat` per
input and per directory a glob reaches. A cache hit runs no command and
checks nothing.

## Why even identical bytes count

The hard case is a file that changes and changes back. Say you save an
edit while a build runs, then undo it. The file's bytes match the digest
again, yet the output was built from the edit. A byte comparison alone
would save that output under the original key and restore it over your
code later.

So a file written after the key was taken counts as moved, whatever it
holds. That is a deliberate cost: a task that rewrites its own input to
the same bytes (`sed -i` always writes) is never saved, and pays a
re-run each time.

## On CI too

Until today, CI was the exception, on the theory that nobody edits files
on a CI runner. But a task of the same project running alongside can
change an input and put it back, and that is exactly the case a byte
check misses. As of #3420 the check is the same everywhere.

## The opt-out, per task

Some tools rewrite their own input with identical bytes on every build.
tsdown rewrites `package.json`. For a task like that, tell vx to judge
the write by its bytes:

```ts
build: {
  exec: { command: 'tsdown' },
  cache: {
    inputs: { files: ['src/**', 'package.json'] },
    outputs: { files: ['dist/**'] },
    inputStability: { strategy: 'mutable' },
  },
},
```

Different bytes still withhold the entry. `VX_CACHE_INPUT_STABILITY_STRATEGY=mutable`
makes `mutable` the default for every task that does not say. And when
the file named is not `package.json`, it is usually generated and should
be declared as an output instead, and the status line says so.

`strategy: 'unchecked'` turns the check off. And `severity: 'error'`
(or `VX_CACHE_INPUT_STABILITY_SEVERITY=error`) fails the task instead of
warning, for a pipeline that would rather stop than build twice. The
task's line then names the file, `failed (src/a.ts changed during the run, exit 1)`,
and agents read the same as `inputMoved` in `vx last` and `vx mcp`.

## What runs downstream

A withheld save does not stop at the task. Every task that ran over its
outputs, down the graph, saves nothing either, and a task of any project
that declares the moved file as an input withholds its own. Nothing is
filed on top of a state that was never verified.

## The trade

A run whose inputs moved pays a rebuild next time. In exchange, an entry
in the cache always means what its declared inputs say, and a hit can be trusted
without re-reading your inputs. Details:
[Caching](../../caching/).
