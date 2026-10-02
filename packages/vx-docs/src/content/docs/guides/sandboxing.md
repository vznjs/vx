---
title: Sandboxing tasks
description: Run a task where only the workspace files you declared exist, so an undeclared read fails the task instead of hiding in the cache.
---

Prove a task reads only what it declares.

## Steps

1. Add `sandbox` to the task's `exec`. `sandbox: {}` allows nothing in the workspace, not even the package. Outside the workspace root (`~/.cache`, `/etc`) reads are open and fold into no key: declare what the output depends on as a key input.
2. Grant the package: `allow: { read: ['.'] }`. Its `node_modules` is readable already. Another package of yours, linked there, is readable when the task depends on one of that package's command tasks; an uncached task reads every linked package.
3. Grant each output directory in `write`, and each host in `network`. The sandbox does not read `cache`: declare both.
4. Run the task. An undeclared read or write fails it and names the path.
5. Declare that path, or silence a noisy tool's path with `ignore`.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: {
        command: 'vite build',
        sandbox: {
          allow: {
            read: ['.', '~/.cache/ms-playwright'],
            write: ['dist/**'],
            network: ['registry.npmjs.org'],
          },
          deny: { network: ['telemetry.example.com'] },
          ignore: { write: ['*.bun-build'] },
        },
      },
      cache: { inputs: { files: ['src/**', 'index.html'] }, outputs: { files: ['dist/**'] } },
    },
  },
})
```

## What you can grant

`allow` takes every key below. `deny` takes only `network`. Domain lists are one union per run, which every sandboxed task reaches; `deny.network` is refused to every sandboxed task. `ignore` takes `read`, `write`, `systemInfo` and `network`, as patterns, and refuses the rest.

| Key            | Grants                                                            |
| -------------- | ----------------------------------------------------------------- |
| `read`         | paths or globs: package-relative, absolute or `~/`                |
| `write`        | paths or globs; a directory ends in `/` or is a glob (`dist/**`)  |
| `network`      | `true`, or a list of domains (`*.sentry.io`)                      |
| `localBinding` | bind localhost ports (macOS; Linux needs no grant); a list (`[3000]`) makes them reachable from outside |
| `unixSockets`  | `true`, or socket paths (Linux: any path)                         |
| `systemInfo`   | sysctl names a tool probes (`vfs.disk-space`)                     |
| `machLookup`   | macOS services (`com.apple.FSEvents`)                             |
| `pty`          | a terminal                                                        |
| `gitConfig`    | write the repository's `.git/config`, for this task only          |

## The boundary is the project

A task never reaches another package or a root file you did not grant,
bar the linked packages of step 2.
That wall is silent. An undeclared touch of the task's own files fails the
task, and a failed task is never cached. A write refused past the wall
(a tool filling its cache in your home) is named beside a failed task,
with the directory to grant.

## Requirements & platform support

- **Linux:** `bubblewrap` (`bwrap`), `socat` and `ripgrep` (`rg`); `strace` to fail and name an undeclared read. `vx info` says if your host can.
- **macOS:** the system sandbox. Its report can miss a record under load; the denial never does.
- **Windows:** under WSL.

## What can't be sandboxed

- A group task: it has no command.
- A task that itself sandboxes, on macOS (a sandbox cannot nest).

## Common problems

- **`write /proc/self/uid_map: Operation not permitted`.** You are root in a container. Run as a normal user, or set `weakerWhenNested: true` on every sandboxed task.
- **`File exists` from the task's own `mkdir`.** A write grant with no trailing slash is a file. Write `'coverage/'`.
- **A file the task creates later is refused on Linux** ("Read-only file system"). A glob with a file part (`*.log`, `gen/**/*.ts`) is matched when the task starts. Grant its directory (`'gen/'`; `'dist/**'` grants the directory too). A temp directory the tool makes and removes in the package (`.*.tmp/**`) needs only the glob: nothing written there is kept.
- **`bun build --compile --target=…` fails on a fresh machine** ("Network error downloading executable", then "Failed to extract executable"). Bun fetches the target's runtime from npm into its cache. Grant `network: ['registry.npmjs.org']` and `write: ['~/.bun/install/cache/', '.*.tmp/**']`.
- **`read packages/ui through packages/app/node_modules/@x/ui, and its key folds no task of @x/ui`.** The task imports a sibling its key never sees. Depend on a command task of it (`dependsOn: ['^source']`, or `^build`), or grant and key the files yourself.
