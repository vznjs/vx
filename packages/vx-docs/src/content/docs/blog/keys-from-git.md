---
title: "Your cache key is already in git's index"
date: 2026-09-10T23:55:00Z
authors:
  - vzn
tags:
  - internals
  - caching
excerpt: "Hashing inputs is the cost every cache pays. vx pays it once, in git, and reads the blob ids back. Here is how the key is derived, part by part, and why a commit never flips it."
---

A content-addressed cache stands or falls on one question: how cheaply
can you compute the key, and how sure are you that the key captures
everything that matters? This post is about the first half. The next
few are about the second.

## Twelve parts, one chain

A vx cache key is an xxh3 hash, seed-chained across twelve parts:
each part folds into the running digest under its own label
(`task:`, `workspace:`, `config:`, `upstream:`, `inputs:`, …), and
every list of pairs folds its length first and delimits name from
value with a `\0`, so no two layouts of the same bytes can collide by
concatenation. The parts, as [Caching](../../caching/) numbers them:

1. The key-derivation sentinel (`CACHE_VERSION`), so a change to how
   keys are derived can never be served by an entry from before it.
2. The task id, `project#task`.
3. The **workspace fingerprint**: every supported workspace-level file
   at the root (lockfiles, `pnpm-workspace.yaml`), hashed once per run.
4. The project's own `package.json` bytes. A dependency bump re-keys
   the project it belongs to.
5. The **resolved task config**, the evaluated object, not the source
   text ([its own post](../resolved-config-hashing/)).
6. Arguments forwarded after `--`.
7. The resolved values of the env vars in `cache.inputs.env`.
8. The output of each `cache.inputs.runtime` command (`node --version`,
   say), resolved live at hash time.
9. The same for `workspaceRuntime`, resolved once per run.
10. Every upstream task's cache key, filtered to the ones the graph says
    this task depends on ([cascade post](../cascade-through-inputs/)).
11. Any material a plugin's `key` stage contributes — folded right
    after the upstream keys and BEFORE the input files, and only when a
    plugin returned any, so a workspace with no `key` plugin derives
    the keys it derived before the stage existed.
12. The content hashes of every file `cache.inputs.files` resolves to.

Part 12 is where the money is. A build task in a real package resolves
to hundreds of files, and a workspace has hundreds of packages.

## Ask git, once

Git already stores a content hash for every tracked file: the blob
object id in the index. vx runs one `git ls-files -s -v` for the whole
workspace — the index only, no walk — and gets every tracked path, its
blob id and its cache-state flag in a single stream. A concurrent
`git status --porcelain -uall` is the one command that walks the
worktree, and it answers two questions at once: which tracked files
differ from the index, and what is untracked.

An index id is trusted only where git stores the worktree bytes
verbatim, so three prunes run against it: a dirty path (status), a
`skip-worktree` or `assume-unchanged` path (the `-v` flag, whose id
says nothing about what is on disk), and a path a clean filter could
rewrite. Every pruned path, and every untracked one, is hashed
in-process with the exact blob-id algorithm git uses
(`blob <size>\0<bytes>`, SHA-1 — or SHA-256 in an
`--object-format=sha256` repository).

The consequences:

- **A clean tree costs no file reads.** No `open`, no `stat`, no lookup
  in a hash database, for any tracked-clean file. The per-file cost is
  a string in a stream.
- **A commit never changes a key.** The dirty-file hash and the
  committed-file hash are the same blob id, so editing a file, running,
  committing and running again is one miss followed by one hit. Tools
  that hash mtimes or keep their own fingerprint store see a second
  miss at the commit boundary, or lean on a daemon to avoid it.
- **Clean filters are not trusted.** Under a `text`, `eol` or `ident`
  attribute, or with `core.autocrlf` on, the index holds a normalised
  blob while your build sees different bytes, and `git status` calls
  the file clean. vx drops the index id for exactly those paths and
  hashes the working-tree bytes instead. A repository with no
  attributes file and no `core.autocrlf` pays nothing for the check:
  the gate is one `git var -l`, which also names the attributes files
  git reads outside the tree, and a stat of each.

Ignored files are not inputs; if your task reads a
generated file, declare the task that generates it as a dependency and
let the cascade carry it.

## Boundaries are hard

`cache.inputs.files` globs are resolved inside the project's directory
and nowhere else. `../shared/**` is an error, not a wider key. The
reason is not purity: a glob that crosses into a sibling makes that
sibling's edits invisible to the sibling's own dependents while making
this project's key depend on files it does not own. What a project
needs from another arrives as an upstream task's outputs, and its key
arrives through part 10. The one deliberate exception is
`cache.inputs.workspaceFiles`, which addresses files at the workspace
root (a shared `tsconfig.base.json`) and says so in its name.

## What the key deliberately ignores

- `exec.env.passThrough` values. They reach the command but not the
  key, because a `HOME` or a `CI` that differs per machine would defeat
  a shared cache. If a variable changes the output, list it under
  `cache.inputs.env` instead.
- Tool versions you did not declare. `node --version` is a
  `cache.inputs.runtime` line away.
- `exec.remote`. Placement. Where a task ran says nothing about what it
  produced.
- `vx-lock.json`, so that `vx lock` itself does not re-key the world.

When a key does change and you want to know which of the twelve parts
moved, that is [`vx why`](../why-did-this-rerun/). The full derivation
with every rule and its history is in [Caching](../../caching/).
