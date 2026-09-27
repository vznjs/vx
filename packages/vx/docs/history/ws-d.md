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

- A: `cache.outputs.files: ['{dist,lib/esm}/**']` saves an empty
  artifact and a hit restores nothing — `scanUnion` (cache/inputs.ts)
  scans with `Bun.Glob`, whose scan skips a brace holding a slash.
- B: the sandbox's mount-glob expansion (`sandbox-runtime.ts`, scanSync)
  has the same shape; not probed.
- C/E: flaky rows seen here: `watch-loop` "a server that rewrites a file
  … (item 948)" (CI, PR 1125), `signal-handling` "every task process is
  gone" (local gate under load).

## Entries

- **D-1** `--affected` selects the project a new nested project took
  files from (lead 1). `parentsOfNewNested` in `affected.ts`: a changed
  manifest of a project with a project above it is read at the base;
  absent or nameless there, the parent is selected. Row: `tests/affected.test.ts`
  "a new nested project selects the project it took files from (D-1)",
  red without the fix. Docs: `cli.md` § `--affected`, `modules/affected.md`.
- **D-2** Discovery scans a `workspaces` brace holding a slash
  (`packages/{a,nested/b}`) as its expansions; `Bun.Glob`'s scan found
  none of its members. Row: `tests/workspace.test.ts` "a brace whose
  alternatives hold a slash lists every member (D-2)".
- **D-3** `--affected` selects a dependent whose edge a manifest edit
  dropped (lead 2): the package graph is rebuilt over the changed
  manifests as the base had them (one `git cat-file --batch`, shared
  with D-1's check) and every project whose `directDeps` differ is
  selected; replaces the removed-package walk. Row: `tests/affected.test.ts`
  "a manifest edit that drops an edge selects the dependent (D-3)".
- **D-5** The config worker awaits a Promise default export, as the
  in-process first load's async return already did: an async config
  loaded on a run and was refused as "an instance of Promise" on every
  later evaluation in the process (a `vx watch` cycle). Row:
  `tests/config-eval.test.ts` "reads a Promise default export the same on
  the first and the repeat load (D-5)".
