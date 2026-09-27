# Workstream G — adoption (`vx-migrate`, `vx-lockfile`, `vx-schedule-history`)

## Leads (review of 2026-09-27)

Probed against real repos cloned outside the tree: create-t3-turbo
(pnpm 10, Turbo 2.5), astro (pnpm, Turbo), turborepo itself (pnpm 11,
Turbo 2.11), and Turbo's own lockfile corpus (`lockfile-tests/fixtures`,
`examples/*`: 163 lockfiles across pnpm v5.3–v9, npm, yarn classic and
berry, bun). `turbo run … --dry=json` against `vx run … --all
--dry=json`, dependency closures compared with Turbo's no-op nodes
collapsed: create-t3-turbo 25 of 25 tasks and astro 122 of 122 agree.

1. pnpm 10.x / 11 multi-document `pnpm-lock.yaml` (the env lockfile
   ahead of the project's) refused as "not a YAML document — regenerate
   it", which regenerates the same file: turborepo's own lockfile, the
   `pnpm-v11-multi-document` fixture and 8 of its examples. G-1.
2. Turbo 2.11's task `command` (`futureFlags.experimentalTaskCommand`)
   is reported as "no vx equivalent" and ignored. Turbo treats it as
   authoritative: an argv runs where the package has no script, `null`
   never runs. On turborepo itself vx misses `@turbo/types#build`,
   `docs#schema`, `docs#collect-examples-data`, `@turbo/gen#build:embed`,
   so it drops the edges to them (`docs#build` runs before the schema it
   copies), and runs the script body where the command differs.
3. Every other lockfile edge in the corpus resolves: pnpm by snapshot
   key, npm and bun by the node_modules walk, yarn berry by descriptor
   (its peer ranges and `resolutions` overrides fall back to every entry
   of the name, conservative by design). No dangling edge found.
4. Cargo crates Turbo discovers under `experimentalCargoWorkspaces` are
   outside vx's JS discovery: 117 of turborepo's 125 `build` tasks. A
   recorded refusal, not a row.

## Leads for other streams

- **C/E:** in a `turbo()` workspace, `vx run build --all --dry=json`
  prints the plugin's warnings on STDOUT ahead of the JSON (the project
  stage's `warn` is `log.status` in `orchestrator/prepare.ts`), so the
  output does not parse (`… --dry=json 2>/dev/null | jq` fails on
  create-t3-turbo). Warnings belong on stderr, at least under `--json`
  modes.

## Record

- **G-1.** pnpm multi-document lockfiles read (lead 1).
  `parseLockfile` takes the last non-empty YAML document as the
  lockfile and folds the ones before it into every importer's global
  digest, only when there are any, so a one-document lockfile keys as
  before. Rows (`pnpm.test.ts` › every input the pnpm digest must
  read): the last document is read and a bump in it moves only its
  importer; an env-document change moves every importer (red with the
  fold removed); a `---`-led one-document file keys as without it
  (control). All 161 text lockfiles of Turbo's corpus now parse.
- **G-2.** Turbo 2.11's task `command` mapped (lead 2). An argv is the
  task's command (each word quoted, from the package dir, no hooks) and
  emits the task where the package has no script; `null` / `[]` is
  Turbo's no-op node, its edges passed through; a toolchain map takes
  `javascript` (alias `typescript`) or leaves the script. On turborepo
  itself every JS task's dependency closure now matches `turbo run build
test check-types --dry=json` (43 tasks; the 75 left are Cargo crates,
  lead 4). Rows (`turbo-map-sweep.test.ts` › a task `command`): seven,
  red without the fix; the `rust`-only map is the control.
- **G-3.** `vx-schedule-history`'s docs say what the plugin packs (lead
  routed by J). The `resources` docstring said a reservation holds "the
  most CPU parallelism seen, rounded to a core", and the README's
  `vx history` sample showed a learned row reserving `· 2 cores`; cores
  are never learned, only declared. The sample was not the renderer's
  output either (column widths, `41.2s`). Row (`history-view.test.ts` ›
  the README sample): the block after `$ vx history` is `renderHistory`
  over the history it shows, reservations taken through
  `resourceEstimates` and `withDeclared` — red on the old sample and on
  `· 2 cores` alone.
- **G-4.** `vx-schedule-history`'s number options are checked. A NaN
  `memory` (`Number(process.env.X)`, X unset) fitted no reservation,
  so every task that reserved memory waited for an idle machine and
  the run went serial with no word; a NaN `headroom` dropped every
  learned reservation; a fractional or NaN `window` reached the
  history query. Each non-finite, non-positive value (and a fractional
  `window`) runs on its default, named in one warning per run and by
  `vx history`, as `assume` does (item 930). Rows: `resource-estimates`
  › a `memory` that is no number above 0 packs against the default
  (NaN, 0, −1); `schedule-history-e2e` › `vx history` shows the default
  budget and the learned reservation, the warning on stderr. Both red
  without the fix.
