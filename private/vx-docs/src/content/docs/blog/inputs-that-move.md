---
title: 'When an input moves mid-run, vx keeps the result and skips the save'
date: 2026-10-12T17:40:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'A cache key describes the inputs at the moment it was taken. If one changes while the command runs, the output was built from something the key does not name. vx keeps your result, saves no entry, and names the file, on CI too.'
---

A one-second build, and a save in the editor halfway through it:

```sh frame="terminal"
$ (sleep 0.5; echo "// saved mid-build" >> packages/a/src/index.ts) &
$ vx run packages/a#slow
┌─ packages/a#slow > $ sleep 1 && mkdir -p gen && cp src/index.ts gen/copy.ts
[vx] packages/a#slow: `packages/a/src/index.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs
└─ packages/a#slow ── (1.01s) success
  tasks     1 success · 1 total
  cache     1 not saved

$ vx run packages/a#slow
└─ packages/a#slow ── (1.01s) success
  cache     local 1↑
```

The run is green and its output stays. No entry is saved, and the next
run builds again from what is on disk. Demo workspace, vx at
`69617eb`, 2026-10-23.

vx takes the key just before the command runs. The output above was
built from bytes that key doesn't describe. Filed under it, the next
hit would replay the wrong output.

## How it notices

After the command, vx checks each input once:

| Input after the command                 | Verdict |
| --------------------------------------- | ------- |
| touched after its digest was learned    | hashed again and compared |
| gone                                    | moved   |
| new file matching an input glob         | moved   |

On a miss that saves, this costs one `lstat` per input and per
directory a glob reaches. A cache hit runs no command and checks
nothing.

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

Nobody edits files on a CI runner, but a task of the same project
running alongside can change an input and put it back, and that is
exactly the case a byte check misses. So the check is the same on CI
as on your machine.

## The opt-out, per task

Some tools rewrite their own input with identical bytes on every build.
tsdown rewrites `package.json`. For a task like that, tell vx to judge
the write by its bytes:

```ts
build: {
  exec: { command: 'tsdown' },
  inputs: { files: ['src/**', 'package.json'] },
  cache: {
    outputs: { files: ['dist/**'] },
    inputStability: { strategy: 'mutable' },
  },
},
```

Different bytes still withhold the entry, and so does a write made
while another task that may write the file was running, since it may
have changed the file and put it back; the line names that task.
`VX_CACHE_INPUT_STABILITY_STRATEGY=mutable`
makes `mutable` the default for every task that does not say. And when
the file named is not `package.json`, it is usually generated and should
be declared as an output instead, and the status line says so.

`strategy: 'unchecked'` turns the check off. And `severity: 'error'`
(or `VX_CACHE_INPUT_STABILITY_SEVERITY=error`) fails the task instead
of warning, for a pipeline that would rather stop than build twice. The
task's line then names the file,
`failed (src/a.ts changed during the run, exit 1)`, and agents read the
same as `inputMoved` in `vx last --failed --format json`.

## What runs downstream

A withheld save does not stop at the task. Every
task that ran over its outputs, down the graph, saves nothing either,
and a task of any project that declares the moved file as an input
withholds its own. Nothing is filed on top of a state that was never
verified.

## The trade

A run whose inputs moved pays a rebuild next time. In exchange, an entry
always means what its declared inputs say, and a hit can be trusted
without re-reading your inputs. Details: [Caching](../../caching/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
