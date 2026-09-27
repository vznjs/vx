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
6. Ctrl-C or Ctrl-D at the `vx run` picker printed `vx: AbortError` with
   a stack, exit 1 (E-6).
7. `vx cache prune` on a workspace that never ran created `.vx/cache`
   (E-7).
8. `vx watch buidl` printed the refusal and watched forever (E-8).

## Leads for other streams

- C: `No projects declare task(s): <name>.` from a real run goes to
  STDOUT through `log.status` (`src/orchestrator/run.ts`), while
  `docs/cli.md` § Top-level shape says "on stderr" and the `--dry` path
  (`src/cli/run.ts`) prints it on stderr as `vx run: no projects …`. A
  `2>err.log` CI step loses the one line that says why it went red.
- J: `docs/cli.md` § Plugin commands showed a plugin as a plain object
  with a `name` field, which the loader refuses. Fixed by J-9.
- C: `vx watch` reads "the initial run refused to start" off the
  result's shape (`ok: false, outcomes: []`, E-8), the only way
  `RunSummary` says it today. Carrying the unresolved names on
  `RunSummary` would make that a field instead of an inference.
- F: `packages/vx-reapi/tests/wedged.test.ts` — "RST_STREAM(CANCEL)
  reads as CANCELLED and is not retried" (F-1's control row) went red
  twice in this stream's full gates (`sent: 0` for `1`) and is green
  alone (3 of 3): a race between the proxy's cut and the count.

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
- E-4 — `vx completions` offers only the flags each verb accepts (its
  Usage line; run's option lines less `WATCH_REFUSED_FLAGS` for watch),
  and `vx run --chek` no longer suggests the refused `--check`; rows
  parse every completed flag through its verb's own parser.
- E-9 — Sweep of `cli/cache.ts` and `util/size.ts` (never named): 41
  mutants, 29 caught, 1 inconclusive (the unwritable-cache refusal:
  its row is `skipIf(root)`, held by CI's non-root job), 2 equivalent
  (`cache.close()` and the run lock's release: process exit does both,
  the lock through its exit hook), 9 held now. The harmful ones: an
  unparsable `--older-than` or `--max-size` reached the prune as `null`
  (a cutoff of now; a null cap), and a `--dry-run` that stopped
  reaching the cache would have deleted with the suite green. Rows in
  `tests/cli.test.ts`, `tests/cache-prune-verb.test.ts` (new),
  `tests/schema-reset-notice.test.ts`.
- E-5 — A plugin verb's exit code must be an integer 0–255; 256 exited
  0 and -1 exited 255. Row in `tests/plugin-commands.test.ts`.
- E-6 — Ctrl-C at the run picker exits 130, Ctrl-D exits 1 with `no
task picked`; neither prints a stack. Row in
  `tests/cli-picker.test.ts` drives both through a TTY-mode interface.
- E-7 — `vx cache prune` with no cache prunes nothing, exits 0 and
  creates nothing. Rows in `tests/inspect-no-create.test.ts`.
- E-8 — `vx watch` exits 1 when its initial run refuses a name no
  project declares, as `vx run` does. Row in `tests/watch-loop.test.ts`.
- E-10 — Sweep of `cli/index.ts` and `cli/help.ts` (never swept): 30
  mutants, 26 caught, 3 equivalent under the current text, 1 unheld —
  the gate that keeps `vx <plugin-verb> --help` for the plugin. Row in
  `tests/plugin-commands.test.ts`.
