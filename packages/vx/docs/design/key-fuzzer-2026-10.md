# The key fuzzer: a differential probe for stale hits (2026-10-02)

**Status: a tool, run by hand.** `scripts/fuzz-keys.ts` is not a gate
task: a run is minutes of `vx run` spawns, and a seed that finds nothing
proves nothing about the next. Run it after a change to how a key reads
the worktree (`src/cache/git-inputs.ts`, `inputs.ts`, `file-hashes.ts`,
`key-fold.ts`, the hit path).

```sh
cd packages/vx
bun scripts/fuzz-keys.ts <scratch-dir> 300 <seed>             # a few seeds, in parallel
bun scripts/fuzz-keys.ts <scratch-dir> 300 <seed> --policies  # random --force / --no-cache / --cache=
```

## The method

The workspace's tasks print what they read: each listed `src` file's
name, mode bit and bytes or link target, a constant from an imported
`conf.mjs`, a cached producer's output read by content (`tasks: []`), a
`workspaceFiles` input, and the upstream's output. After each random
edit, one `vx run build --all`, then every output is compared with what
the current inputs produce. A mismatch is a hit that replayed bytes its
key does not describe, the worst failure class; a seed replays it
exactly.

The edits are the ones a key can miss: content, a same-size rewrite with
the times put back (`forge`), chmod, symlinks, renames, `git add`,
commit, stash and pop (conflicts included), checkout, reset, `add -N`,
index flags (`assume-unchanged`, `skip-worktree`, `--chmod`),
`.gitignore`, `.gitattributes`, `core.autocrlf`, and tampering with
declared outputs.

## What it found

Three stale hits in its first afternoon, each a fix with a row:

- A-59: `git status` paired a deleted file with a similar unmerged path
  as its rename source and printed only `UU <path>`
  (`--no-renames`).
- A-60: a blob a removed clean filter wrote stood for the CRLF bytes on
  disk (the blob-size check).
- A-61: a gitlink whose directory lost its `.git` listed none of its
  files (`walkFiles`).

The one probe of the script itself: with the file-hash memo's ctime and
inode checks deleted, seeds 1 to 3 each report a stale hit by step 23.

## What it does not cover

The oracle reads git's view of `src`, so an embedded repository there is
out of its set (A-61 was found by a `find`-based variant). Two clones
sharing a remote layer, and two runs sharing a `--cache-dir` at once,
were fuzzed the same way (about 5,600 steps, clean) by variants not kept here.
