# Workspace-root tasks (2026-09-28, stream D)

**Status: shipped as D-39 (`docs/history/ws-d.md`).**

Every adoption path dropped a task that lives at the workspace root:
Turbo's `//#task`, Nx's root project, wireit and lage root scripts.
microsoft/fluentui-react-native builds with one root `tsc -b` that all
85 packages' `test` wait on; under `lage()` they tested with nothing
built (stream N, `docs/history/ws-n.md`).

Core already runs a root project: a workspace whose package globs list
`.` (this repo does) makes the root package a project with the same
rules as any other. What was missing is a way to declare one without
changing the package manager's own member list, which changes what the
manager does: npm 10 given `.` in `workspaces` links the root into its
own `node_modules` and runs the root's script under `npm run x
--workspaces` (probed).

## Declaration

A `vx.config.*` in the workspace root makes the root package a
project when no package glob already reaches it. That file was ignored
before: a `root#build` edge refused with "no such project", and
`vx run build` at the root said "not inside a project". The file is
the opt-in (principle 2, explicit over magical): a root with no config
is not a project, as before. The project's name is the root `package.json` `name`; a
root with a config and no name is skipped with the warning a member
gets.

## Inputs and boundaries

Unchanged, and the reason this needs no new rule (principle 6). The
root project's directory is the whole workspace, so every member is a
nested project: `nested-dirs.ts` drops a member's paths from the root's
globs, and the sandbox grants the root task none of them. A root task
owns only the files no member owns. A root task whose command reads
members' sources (FURN's `tsc -b`) cannot cache on its own globs: it
declares those files through `cache.inputs.workspaceFiles`, the
documented boundary exception, or runs uncached. A mapper that emits
one says which.

## `--affected`

Unchanged. Containment gives a changed file to its deepest owner, so a
file under a member selects the member and a file owned by no member
(a root script, `tsconfig.base.json`) selects the root. A root task
that declared `workspaceFiles` is selected by that channel for the
member files it names. Dependents follow the graph as for any project.

## Key

Unchanged: the root project's key folds its config, its own
`package.json` bytes, the workspace fingerprint and its upstream keys,
like any project.

## Cost

One config lookup at the root per discovery, run beside the member
scans; nothing when a glob already lists `.`.
