# Workstream D (workspace and config) — the record, one entry per merged PR

## Leads (review of 2026-09-27)

In order of harm. `--affected` under-selection is a re-keyed task a CI
run leaves out; the rest are refusals.

1. `--affected`: a `package.json` that makes an existing directory a
   project re-keys the project above it (its inputs stop at the new
   one) while containment maps the change to the new project alone.
   Repro: `a` with `**` inputs and `a/sub/data.txt`; add
   `a/sub/package.json` with a name; `--all --dry` says `a#build`
   misses, `--affected=HEAD~1` selects nothing that declares `build`.
2. `--affected`: an edited manifest whose `name` or `version` moved
   drops an edge at the base graph that today's graph cannot see. `app`
   declares `lib: ^1.0.0`; bump `lib` to 2.0.0 (or rename it `lib2`)
   and `app#build` re-keys (its upstream is gone) while `--affected`
   selects `lib` alone. The item-959 walk reads only DELETED manifests.
   Fix shape: build the package graph over the base manifests of the
   changed ones and select every project whose `directDeps` differ
   (subsumes the removed-package walk).
3. Schema: a NUL in `exec.command`, `cache.inputs.runtime` /
   `workspaceRuntime` loads, and fails at spawn as "exit 127 … not on
   this task's PATH" with the NUL printed as a space — item 999's
   class (env names), not yet applied to commands.

## Leads for other streams

(none yet)

## Entries

- **D-1** `--affected` selects the project a new nested project took
  files from (lead 1). `parentsOfNewNested` in `affected.ts`: a changed
  manifest of a project with a project above it is read at the base;
  absent or nameless there, the parent is selected. Row: `tests/affected.test.ts`
  "a new nested project selects the project it took files from (D-1)",
  red without the fix. Docs: `cli.md` § `--affected`, `modules/affected.md`.
