# 0.1.0 — draft release notes (2026-09-22)

**Status: a draft for the owner to cut the release from (launch checklist
item 2; plan D4).** 341 pull requests merged since v0.0.21 (2026-09-15),
every one a titled squash, so GitHub's generated notes are accurate; this
page is the same record grouped by what a user meets, with the internal
work in one line at the end. Version: `0.1.0` says "first real release"
where 0.0.22 says "another nightly".

## Selecting and running

- `--affected` selects the changed projects **and their dependents**, the
  superset a CI gate needs; `--filter '[<base>]'` is the changed-only form.
  A base that is HEAD itself, and a shallow clone, are named for what they
  are.
- One run at a time per workspace on this machine; the lock's release is
  awaited, so a CLI run leaves no lock directory behind.
- A task dies with everything it forked: process groups, `SIGHUP` on
  teardown, and a skipped task's row names the blocker that skipped it.
- A task says why when its shell or its temp directory refuses it; a `git`
  that is not on PATH is one refusal, never a stack; a typo'd verb is one
  line with a help pointer, and an unknown verb is answered with the verbs
  this workspace declares.
- `vx watch`: a git-ignored path never starts a cycle, and a task that
  rewrites its own inputs is named.
- Every package's code floor matches the `engines` it declares (Bun ≥
  1.4); `vx info` reports it, and `vx` warns once below it.

## Caching

- A negation pattern subtracts from the root walk too; a literal output is
  read as the tree it deletes; glob prefixes compare as paths, not
  spellings; an output collision spelled with `?`, a character class or a
  brace is refused like one spelled with `*`.
- A gitignored file **or directory** named as a literal input is refused
  rather than silently folding nothing (the stale hit the refusal exists
  to stop).
- A failed git command is an error, not an empty answer; a tree that is
  not a git checkout is refused on the fallback enumeration; git
  attributes are read where git keeps them.
- `.git` and `.vx` are never touched by an output wipe; an emptied parent
  directory is pruned after a clean, so a later restore's rename is never
  blocked by it.
- A project inside a nested repository is enumerated by its own git, and
  every project under a changed nested repository is `--affected`.
- A cache directory this user cannot write opens read-only for the readers
  and fails a run before any task; a full disk, a staged file another run
  removed, an output vx cannot remove — each is one line naming the path,
  never a stack or a "corrupt artifact".
- A remote cache layer's wrong shape is named as such; a refused remote
  token is reported once, not once per in-flight call; an artifact with no
  stdout is refused without leaving one behind; a NUL-bearing or empty
  archive name is refused through the pax door too.
- An upstream with no cache key is pinned and explained (`vx why` says why
  its consumer's key moved after the upstream's first run).

## Sandbox (Linux `bwrap`, macOS seatbelt)

- The post-run sweep no longer deletes what the task itself wrote; a
  write grant that mounts nothing is reported with what to write instead;
  a write grant that meant a directory is spelled `dir/`.
- A sandboxed task is pinned to this machine (its profile describes this
  host); each sandboxed task gets its own strace trace; a dead process's
  mux socket under a recycled pid is removed before the runtime listens.
- The sandbox names its three Linux dependencies (`bubblewrap`, `socat`,
  `ripgrep`) when one is missing, and `vx info` reports the runtime's
  verdict and the tasks that need it.
- A task that produced nothing under the sandbox has its cause named.

## Failures and what they say

- A failure is labelled once, with its signal, on every surface: the
  frame, the GitHub summary's callout, `vx last`'s replay of exit code and
  signal, the runs table. An exit above 128 names its signal; 127 and 126
  name the shell's verdict; a timeout is labelled as its reason; sandbox
  violations are counted in the label and every record.
- `vx last` folds hits past sixteen rows and names each skipped task under
  the failure that blocked it; a persistent task that never became ready
  is labelled by its reason.
- File-system refusals (`EACCES`, `ENOSPC`, a lockfile that cannot be
  read) print one line naming the path and the side.

## Plugins and packages

- `@vzn/vx-migrate`: Nx's runtime input maps to `cache.inputs.runtime`,
  `project:target` to `project#target`, a package `turbo.json` merges over
  the root task, `extends` is in the table; the generated `vx-preset.ts`
  names the tool as the configs do; the overlap rule is core's, not a copy.
- `@vzn/vx-otel`: `timeoutMs` is wired; a collector that refuses or drops
  the export is reported.
- `@vzn/vx-github`: the job summary is bounded by GitHub's 1 MiB cap and
  the CI guide shows it.
- `@vzn/vx-mcp`: `whyDidThisRerun` defaults to the latest run;
  `getRunHistory` names the usage its rows carry.
- `@vzn/vx-reapi`: the plugin refuses a Bun below its floor at its wire;
  `--force` reaches a remote executor.
- A telemetry sink that swallows a failure still owes a warning; the
  plugin boundary's sentences are pinned.

## CLI and upgrade

- `vx upgrade` verifies the release digest, refuses a binary npm owns, and
  names the host it could not reach; the README's install row says what
  exists.
- `vx lock` names the projects it cannot freeze; `vx info` names a broken
  config once and counts its sandboxed neighbours' declarations; `vx cache
stats` points at the verb that answers it.
- Piped stdout is flushed before the CLI exits, and a reader that leaves
  (`| head`) does not fail the run.

## Docs and site

- Every page of the site and every module page was read against source
  and pinned to it (a change to the code that a page quotes fails a test).
  The introduction states vx's known limits in one place; the CI guide
  names the GitHub plugin; `--affected` includes dependents everywhere.

## Internals

- A per-file mutation sweep of core (items 342–572) with ~14k lines of
  witness tests behind the fixes above; the suite's twelve shards are
  weighed and balanced; the gate refuses a Bun below the floor before any
  shard starts; CLAUDE.md and STATUS trimmed to what a session needs.
