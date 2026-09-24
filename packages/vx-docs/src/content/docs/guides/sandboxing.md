---
title: Sandboxing tasks
description: Run a task where only the files and network you declared exist, so an undeclared read fails the task instead of hiding in the cache.
---

Prove a task reads only what it declares.

## Steps

1. Add `sandbox` to the task's `exec`. `sandbox: {}` allows nothing, not even the package.
2. Grant the package: `allow: { read: ['.'] }`. Its `node_modules` is readable already. Another package of yours, linked there, is readable when the task depends on one of that package's tasks.
3. Grant each output directory in `write`, and each host in `network`. The sandbox does not read `cache`: declare both.
4. Run the task. An undeclared read or write fails it and names the path.
5. Declare that path, or silence a noisy tool's path with `ignore`.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

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

`allow`, `deny` and `ignore` take the same keys.

| Key            | Grants                                                            |
| -------------- | ----------------------------------------------------------------- |
| `read`         | paths or globs: package-relative, absolute or `~/`                |
| `write`        | paths or globs; a directory ends in `/` or is a glob (`dist/**`)  |
| `network`      | `true`, or a list of domains (`*.sentry.io`)                      |
| `localBinding` | bind localhost ports; a list (`[3000]`) makes them reachable from outside |
| `unixSockets`  | `true`, or socket paths                                           |
| `systemInfo`   | sysctl names a tool probes (`vfs.disk-space`)                     |
| `machLookup`   | macOS services (`com.apple.FSEvents`)                             |
| `pty`          | a terminal                                                        |
| `gitConfig`    | writes to `.git/config`                                           |

## The boundary is the project

A task never reaches another package or a root file you did not grant.
That wall is silent. An undeclared touch of the task's own files fails the
task, and a failed task is never cached.

## Requirements & platform support

- **Linux:** `bubblewrap` (`bwrap`), `socat` and `ripgrep` (`rg`). `vx info` says if your host can.
- **macOS:** the system sandbox. Its report can miss a record under load; the denial never does.
- **Windows:** under WSL.

## What can't be sandboxed

- A group task: it has no command.
- A task that itself sandboxes, on macOS (a sandbox cannot nest).

## Common problems

- **`write /proc/self/uid_map: Operation not permitted`.** You are root in a container. Run as a normal user, or set `weakerWhenNested: true`.
- **`File exists` from the task's own `mkdir`.** A write grant with no trailing slash is a file. Write `'coverage/'`.
- **On Linux a file made during the run is denied.** A glob expands when the task starts: grant its directory.
- **`read packages/ui through node_modules/@x/ui, and its key folds no task of @x/ui`.** The task imports a sibling its key never sees. Depend on a task of it (`dependsOn: ['^source']`, or `^build`), or grant and key the files yourself.
