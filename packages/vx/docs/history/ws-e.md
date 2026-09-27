# Workstream E (CLI and UX) — the record of merged PRs, plan 2026-09-27

## Leads (review of `src/cli/`, `src/bin.ts`, `src/util/`, 2026-09-27)

Every core verb was driven against `docs/cli.md` in a scratch workspace
(bad flags, missing values, unknown targets, a corrupt `cache.db`, a
missing `--cache-dir`, no workspace): exit codes and error lines hold.
What did not:

1. `vx upgrade`: a transfer cut after the headers (`ECONNRESET` from the
   body read) and a release document that is not JSON escaped
   `fetchOrRefuse` as a stack (E-1).
2. `vx upgrade v1 v2`: the second positional was ignored without a word (E-2).
3. `vx info --format json`: the reference's field list lacked
   `bunSupported` and `sandbox` (E-3).
4. `vx completions` offered flags each verb refuses (`watch` only the
   four it rejects; `show --run --list`; `lock --frozen`; `run --check`)
   and `vx run --chek` suggested the refused `--check` (E-4).
5. A plugin verb resolving 256 exited 0, the OS keeping eight bits (E-5).

## Leads for other streams

- C: `No projects declare task(s): <name>.` from a real run goes to
  STDOUT through `log.status` (`src/orchestrator/run.ts`), while
  `docs/cli.md` § Top-level shape says "on stderr" and the `--dry` path
  (`src/cli/run.ts`) prints it on stderr as `vx run: no projects …`. A
  `2>err.log` CI step loses the one line that says why it went red.
- J: `docs/cli.md` § Plugin commands shows a plugin as a plain object
  with `name: 'org/mcp'`; the loader refuses exactly that
  (`plugins[i] must come from definePlugin(import.meta, { … })`,
  `src/workspace/config-schema.ts`). The example should be
  `definePlugin(import.meta, { commands: { … } })`.

## Merged

- E-1 — `vx upgrade`: a transfer cut mid-body and a release document
  that is not JSON are one refusal naming the host, never a stack
  (`readOrRefuse`); rows in `tests/upgrade.test.ts`, red without it.
- E-2 — `vx upgrade v1 v2`: a second tag is refused
  (`unexpected argument`) instead of dropped while the first installs;
  row in `tests/upgrade.test.ts` against a copy of the runtime.
- E-3 — `vx info --format json`: the reference's field list is held to
  the `InfoFacts` interface both ways by a drift row (J-9 had just named
  the two missing fields, `bunSupported` and `sandbox`).
