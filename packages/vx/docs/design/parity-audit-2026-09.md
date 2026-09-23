# Parity ledger audit (2026-09-23, item 659, roadmap 2.3)

The two parity ledgers, `turbo-nx-parity-2026-07.md` and
`turbo-nx-test-gaps.md`, listed behaviours vx did not pin, and neither
said which were ever closed. This page is their status. Every verdict
was checked against today's source and tests, not against the ledgers'
own text. Fixes that predate the repository import (`fd161d2d`,
2026-09-03) carry no STATUS item number.

A verdict is one of:

- **FIXED:** the behaviour exists and a test holds it.
- **OPEN:** missing or untested.
- **DECLINED:** out of scope by a written decision.
- **OBSOLETE:** the entry targets code that no longer exists.

## Totals

| Ledger                | FIXED | OPEN | DECLINED | OBSOLETE | Rows |
| --------------------- | ----- | ---- | -------- | -------- | ---- |
| parity 2026-07, Turbo | 21    | 3    | 1        | 0        | 25   |
| parity 2026-07, Nx    | 13    | 5    | 0        | 1        | 19   |
| test gaps 2026-05     | 31    | 9    | 27       | 3        | 70   |

Two FIXED verdicts are "decided and pinned, behaviour unchanged": T-H5
(`--filter .` is the workspace root) and N-H9 (the essential env
variables stay out of the key).

## The two entries the roadmap named

- **Nx H7, live evaluation without a frozen lock: OBSOLETE.** The entry
  targeted remote agents evaluating configs; those agents and their
  protocol were removed, and `@vzn/vx-reapi` never evaluates a config.
  What remains is covered: a live run hashes the resolved config, so two
  machines that evaluate differently get different keys (a miss, never a
  stale hit); `vx lock --check` names the drift, and `--frozen` consumes
  the lock (`tests/lock.test.ts` "freezes env-dependent configs: live
  runs see env; --frozen trusts the lock; --check audits").
- **Nx L2, a bare name against a scoped package: OPEN.** `--filter core`
  compiles to an exact anchored match (`workspace/filter.ts`
  `compileNameGlob`), so it never selects `@acme/core`; `'*core'` or the
  full name does. Deliberate, but neither a test nor `comparison.md`'s
  Filter DSL section said so.

## Open items

| Ledger ID     | What is missing                                                                                    | Size |
| ------------- | -------------------------------------------------------------------------------------------------- | ---- |
| T-M4          | A row that `build --filter docs app#lint` plans `docs#build` and `app#lint` and never `app#build`. | S    |
| T-M6          | The `{"name": ""}` spelling of an unnamed member, beside the pinned `{}`.                          | S    |
| T-M10         | A range base (`HEAD~1..HEAD`) is refused with the generic "did not resolve"; name ranges.          | S    |
| N-M4          | `--affected` with sibling-prefix project directories (`app`, `app-e2e`).                           | S    |
| N-M6          | Two positive globs with a negation that straddles both.                                            | S    |
| N-M7          | Scheduling unknown-duration tasks first: the benchmark was never run.                              | M    |
| N-L1          | `markSurfacedDeps` over two groups that depend on each other.                                      | S    |
| N-L2          | A bare name does not select a scoped package: a row and a `comparison.md` line.                    | S    |
| gaps §1 L48   | A literal output path holding glob characters (`app/[id]/page.js`).                                | S–M  |
| gaps §1 L53   | Key derivation and a hit inside a linked `git worktree`.                                           | S    |
| gaps §3 L116  | Memoizing `compileNameGlob`: filters parse once per run, so this is closed as not worth doing.     | —    |
| gaps §5 L157  | Restore entries with lookalike Unicode (fullwidth dots, U+2215, bidi overrides).                   | S    |
| gaps §5 L158  | A restore entry longer than `PATH_MAX` refused as a user error, not `ENAMETOOLONG`.                | S    |
| gaps §8 L232  | `turboCache()` / `nxCache()` accept an API URL carrying `user:pass@`.                              | S    |
| gaps §9 L239  | An input row that `src/*` includes `src/.env`.                                                     | S    |
| gaps §9 L255  | A project directory whose name holds brackets (`packages/[abc]`).                                  | S    |
| gaps §15 L355 | The `vx cache prune` CLI row asserts the freed byte figure.                                        | S    |

Everything not in this table is FIXED, DECLINED or OBSOLETE. The
evidence for each (source line and test title) is in the audit's report
of 2026-09-23, summarised here by ledger section:

- **Parity, Turbo:** H1–H6, M1–M3, M5, M8, M9, M11, M12 and L1–L7 are
  FIXED; M7 (a watch edit during the first run) is DECLINED, reasoned in
  `src/cli/watch.ts`.
- **Parity, Nx:** H1–H6, H8, H9, M1–M3, M5 and L3 are FIXED; H7 is
  OBSOLETE (above).
- **Test gaps:** the DECLINED rows each cite `comparison.md`'s
  deliberate differences or CLAUDE.md's rejected list; the OBSOLETE rows
  are a symlink target check (no symlink is ever restored), pre-signed
  URLs and the core HTTP cache (the wire lives in `@vzn/vx-migrate`), and
  pruning a full graph (only the requested closure is built).

The ledgers themselves are left as written, each with a banner that
points here. When an open item closes, strike its row in this table in
the same commit.
