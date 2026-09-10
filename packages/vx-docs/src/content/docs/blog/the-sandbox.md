---
title: 'The sandbox: turning a declaration into a boundary'
date: 2026-09-10T23:48:00Z
authors:
  - vzn
tags:
  - correctness
  - sandbox
excerpt: "A cache is only correct if the declared inputs are the complete set of files the task reads. Instead of inferring that set, vx lets a task run with the declared paths as the only ones it can touch, and fails the run on anything else."
---

The [previous post](../explicit-over-magical/) argued that inputs must
be declared, not inferred. Declared inputs have a weakness of their own:
they can be wrong, and a task that reads a file its inputs never named
produces a cache entry that silently depends on that file. Green check,
stale hit, nothing downstream can tell.

vx's answer is to let you *enforce* the declaration. A task with a
`sandbox` block runs inside an OS-level sandbox where the paths you
grant are the only ones it can read, write or reach.

```ts
lint: {
  exec: {
    command: 'eslint .',
    sandbox: { allow: { read: ['.'] } },
  },
  cache: { inputs: { files: ['src/**', '.eslintrc'] }, outputs: { files: [] } },
}
```

## One allow-list, no inheritance

`sandbox: {}` is the baseline: reads nothing, writes nothing, no
network. Not even the project's own directory, which is why `read: ['.']`
is the first line of nearly every real block. On top of the baseline
you grant exactly what the tool needs:

- `read` and `write` paths or globs, project-relative, absolute or
  `~`-expanded. A write grant is readable too, so `tsc --incremental`
  can re-read its own `.tsbuildinfo`.
- `network`: `true`, or a list of domains with wildcards. Domain lists
  are enforced by one filtering proxy per run; a task that declares no
  network is never given the proxy's port and reaches nothing.
- `localBinding` for a test that boots its own server, `unixSockets`,
  `systemInfo`, and the macOS-specific `machLookup` and `pty`.

There is no workspace-wide default and no inheritance between tasks.
Every sandbox block is the whole permission surface of that one task.

## Why it derives nothing from `cache`

The obvious shortcut would be to grant the `cache.inputs` globs as
reads. vx did that once and removed it. `cache.inputs` says what
*invalidates* a task; `sandbox.allow` says what it may *touch*. When
one was derived from the other, a path added for caching silently
widened the sandbox, and a path the task genuinely needed had to be
laundered through the cache key to become readable. Two declarations,
and the place they meet is the violation: a sandboxed task that reads a
file its inputs never named fails on the denied read, which is exactly
the under-declaration you wanted to find.

## What a violation looks like

An undeclared path *inside* the project is a finding: the run fails
and the report names the path. An undeclared path *outside* the
project is the wall, denied silently, because a project reading its
neighbour is not a mis-declaration to fix but a boundary being held.

A failed task is never cached, so a violation cannot poison the cache.
When a tool is legitimately noisy (a probe for a file that may not
exist), `ignore` silences the specific pattern without granting it.

## How it is built

- **Linux** uses bubblewrap (`bwrap`) and `socat`. The child lives in
  its own mount and network namespaces; an undeclared path structurally
  does not exist, so the tool sees `ENOENT`. With `strace` present, that
  becomes the same structured report macOS produces. Each `localBinding`
  port is bridged to the host's loopback over a unix socket so a
  downstream task or your browser can reach the server.
- **macOS** uses the system sandbox (seatbelt) plus a log monitor for
  the report. Enforcement is the OS's; the unified log feeding the
  report is lossy under load, so a violation can go unreported while
  still having been denied.
- **Windows** is WSL, where the Linux sandbox applies.

The two limits worth knowing: root inside a container usually cannot
create the nested user namespace the Linux runtime needs (run as an
unprivileged user, or accept `weakerWhenNested`), and seatbelt cannot
nest, so a task that itself sandboxes cannot be sandboxed on macOS.
In vx's own repository exactly two tasks have no sandbox block: the
part of the core suite that tests the sandbox itself, and the one
plugin suite that dials service containers on the host's loopback.
Everything else, lint, format, docs build, every other package's
tests, runs inside one.

## Where it fits

The sandbox is opt-in per task. Use it on the tasks whose inputs you
are least sure of, in CI where hermeticity is worth the setup, and
before marking a task eligible for [remote
execution](../remote-execution/), where a worker will see exactly the
declared inputs and nothing else. The guide is
[Sandboxing tasks](../../guides/sandboxing/).
