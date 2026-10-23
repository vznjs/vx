---
title: 'Explicit over magical: why vx never guesses your inputs'
date: 2026-09-10T23:49:00Z
authors:
  - vzn
tags:
  - design
  - values
excerpt: "Inferred inputs are the most requested feature vx will not build. A traced read set says what a task read once, on one machine, after it ran. A cache key has to be right before the task runs, everywhere."
---

Here is the worst thing a build cache can do. This task copies
`notes.md`, but its inputs name only `src/**`:

```ts
notes: {
  exec: { command: 'mkdir -p out && cp notes.md out/notes.md' },
  inputs: { files: ['src/**'] },
  cache: { outputs: { files: ['out/**'] } },
}
```

```sh frame="terminal"
$ vx run packages/a#notes
            local 1↑
$ cat packages/a/out/notes.md
version 1

$ echo "version 2" > packages/a/notes.md
$ vx run packages/a#notes
            local 1✓
$ cat packages/a/out/notes.md
version 1
```

A green run, a cache hit, and the wrong file. Nothing downstream can
tell. That is a **stale hit**, and it comes from one missing input.

## Why not infer the inputs?

Some tools trace the files a task opens and use that list. A trace has
three problems as a key:

1. **It arrives too late.** The key is needed *before* the task runs,
   to decide whether to run it and to ask a remote cache. A trace exists
   only after.
2. **It describes one path.** A build that reads `config/prod.json` in
   production and `config/dev.json` otherwise has two traces and one
   real dependency set.
3. **Defaults widen it.** `**` as the default input turns a README edit
   into a rebuild of every task in the package.

Only the task's author knows what it depends on.

## The two mistakes are not equal

| Mistake                         | What happens                  | Cost                               |
| ------------------------------- | ----------------------------- | ---------------------------------- |
| Over-declared (extra file)      | the task re-runs              | a spurious miss: visible, cheap    |
| Under-declared (missing file)   | the old output is restored    | a stale hit: green, silent, wrong  |

Inference makes the second kind, because a dependency set is larger than
any one run. Declaring lets you err toward the first, and vx gives you
two tools for the second: [`vx why`](../why-did-this-rerun/) for a
re-run on an unchanged key, and the [sandbox](../the-sandbox/): grant reads no wider than the
inputs and the `notes.md` read above fails the run and names the path.

## Explicit everywhere

- `cache` is opt-in. No block, no cache, no default globs.
- `dependsOn` is explicit. `^task` skips a package that lacks the task,
  so no filler tasks.
- Past the essential allowlist every task gets (`PATH`, `HOME`, `CI`,
  `NODE_OPTIONS` and a few more), env reaches a task only through
  `exec.env`. A variable that only has to be present goes under
  `passThrough`. One that changes the output also goes under
  `inputs.env`, which puts it in the key.
- The sandbox derives nothing from `cache`. What a task may *touch* and
  what *invalidates* it are two separate declarations.

The demo ran on vx `0be0367`, 2026-10-23. Write one glob; skip the
afternoon of debugging a stale hit. More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
