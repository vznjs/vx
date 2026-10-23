---
title: 'The sandbox: turning a declaration into a boundary'
date: 2026-09-10T23:48:00Z
authors:
  - vzn
tags:
  - correctness
  - sandbox
excerpt: "A cache is only correct if the declared inputs are every file the task reads. Instead of guessing that set, vx runs a task with the declared paths as the only workspace files it can touch, and fails the run on an undeclared one of its own."
---

A task that reads a file it never declared makes a cache entry that
quietly depends on that file. The check is green, the next hit is stale,
and nothing downstream can tell.

vx lets you enforce the declaration instead. Here a task reads a file
its grants don't name:

```ts
check: {
  exec: {
    command: 'cat src/index.ts notes.md',
    sandbox: { allow: { read: ['src'] } },
  },
  inputs: { files: ['src/**'] },
  cache: { outputs: { files: [] } },
}
```

```sh frame="terminal"
$ vx run packages/a#check
┌─ packages/a#check > $ cat src/index.ts notes.md
export const a = (n: number) => n * 2
export const extra = 1
cat: notes.md: No such file or directory
├─ SANDBOX VIOLATIONS (1) ──────────────────────────────────

openat(notes.md) = -1 ENOENT  [.../packages/a/notes.md]

fix: exec.sandbox.allow: { read: ['notes.md'] }
and, if the output depends on them, inputs.files: ['notes.md']

└─ packages/a#check ── (109ms) failed (exit 1, 1 sandbox violation)
```

The file does not exist inside the sandbox. The run fails, names the
path, and prints the line that fixes it. A failed task is never cached,
so the violation cannot poison the cache.

## What a task may touch

`sandbox: {}` reads nothing in the workspace, writes only its own
`TMPDIR`, and has no network. Not even the project's own directory,
which is why most real blocks start with
`sandbox: { allow: { read: ['.'] } }`. Outside the workspace, `~/.cache`
and `/etc` stay readable; credential stores like `~/.ssh` and `~/.npmrc`
stay denied unless a grant names them.

`allow` holds every grant:

| Grant          | What it opens                                                     |
| -------------- | ----------------------------------------------------------------- |
| `read`         | paths or globs: project-relative, absolute or `~`                 |
| `write`        | the same; a write grant is readable too (`.tsbuildinfo`)          |
| `network`      | `true`, or domains with wildcards, through one proxy per run      |
| `localBinding` | ports a test server listens on                                    |
| `unixSockets`  | unix sockets                                                      |
| `systemInfo`   | named system values                                               |
| `gitConfig`    | writing `.git/config`, for this task only                         |
| `machLookup`   | macOS services                                                    |
| `pty`          | a terminal, on macOS                                              |

Beside it, `deny` (one field, `network`) refuses domains for the whole
run before any allow list, and `ignore` hides a known-noisy denial
without granting it. No workspace default, no inheritance: that is the
task's whole permission surface.

## Grants are not inputs

`inputs` says what *invalidates* a task. `sandbox.allow` says what it
may *touch*. vx derives neither from the other, so the violation is
judged against the grants alone. `read: ['.']` grants the whole
project. Grant no wider than your inputs (`read: ['src', '.eslintrc']`)
and every denial is an under-declared input you wanted to find.

A denial *inside* the project fails the task. A denial *outside* it is
the project wall, held silently. The `fix:` line never lists a
credential path (`~/.ssh`, `~/.aws`, a `.env` file); those are listed
apart, to grant only on purpose. Agents get the same grants as
`sandboxFix` in `vx last --format json`.

## What it costs

One task, `cat` of two files, the whole `vx run --force` timed from
outside:

```
no sandbox                         min 130.7 ms · median 152.5 ms   (20 runs)
sandboxed (bwrap + strace report)  min 377.7 ms · median 410.2 ms   (20 runs)
```

Linux x64, 4 cores, as root in a container, vx at `0be0367`,
2026-10-23. Turn it on where the inputs matter most: in CI, and before a
task goes to [remote execution](../remote-execution/), where a worker
sees only what was declared.

## How it is built

- **Linux** needs `bwrap` (namespaces), `socat` (the network bridge)
  and `rg` (ripgrep, to expand the deny globs). An undeclared path does
  not exist in the task's mount namespace, so the tool sees `ENOENT`.
  With `strace` present, vx turns that into the report above.
- **macOS** uses seatbelt plus a log monitor. The OS enforces every
  denial, but its log can drop a report under load.
- **Windows** is WSL, where the Linux sandbox applies.

Root in a container often cannot create the nested user namespace (run
unprivileged, or accept `weakerWhenNested`), and seatbelt cannot nest.

vx's own repository runs 132 of its 148 command tasks sandboxed. The 16
others are suites a sandbox cannot host, services in Docker, and checks
that drive the sandbox themselves.

Guide: [Sandboxing tasks](../../guides/sandboxing/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
