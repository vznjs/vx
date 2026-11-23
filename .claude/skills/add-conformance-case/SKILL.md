---
name: add-conformance-case
description: Add or change a conformance case in private/vx-conformance (a rival's test or fix, a hardening find, a new behaviour). Covers the case format, running it, sharding, the N/A rule and updating the site data.
metadata:
  internal: true
---

# Add a conformance case

Read `private/vx-conformance/README.md` first: it is the spec (case
fields, expectations, adapters, sandbox). This skill is the procedure.

## Where it goes

- Cases live in `private/vx-conformance/cases/<area>.ts`, each file a
  default export of `defineCase(...)` values (`src/spec.ts`). Add to the
  file of its area; a new file is imported and spread into `CASES` in
  `cases/index.ts` (results keep that order).
- Shared workspace shapes: `cases/shapes.ts`.

## The case

- `id`: `category/slug`, unique, **never renamed or reused** (its
  six-character ref is the site link rivals' issues cite).
- `category`: the file's area. `kind`: `correctness` (wrong tree or exit
  code), `efficiency` (reruns work nobody asked for) or `data` (what the
  tool reports).
- `title`: plain, one line. `why`: 3-4 sentences, why the outcome is right
  and what the alternative costs a user. No AI-smelling copy.
- `from`: existing test files the case is drawn from
  (`tests/inventory.test.ts` checks they exist). A new test file also goes
  in a list in `src/inventory.ts`.
- `needs`: every `Feature` a tool may lack (`src/spec.ts`). What a step
  uses (an install, a selector, `only`, `force`, a report metric…) is added
  on its own by `needsOf`; a new step field a tool may lack belongs there.
- Workspace and steps speak no tool's language. Expectations: `exit`,
  `ran`, `notRan`, `order`, `files`, `filesNot`, `ifReplayed`, `output`,
  `report`, `orRefused`, `within`, `alone` (table in the README).

## Rules (M)

- **N/A only when a tool lacks the feature entirely.** It goes in that
  adapter's `lacks` with one sentence the site shows. A tool that has the
  feature but does it differently passes or fails like any other. This
  holds in every section, run reports too: a tool whose report has no CPU
  time is N/A on a CPU case, one that reports it wrong fails (M, 2026-11-23).
  To reclassify without a rerun, patch the committed rows and scores in
  `conformance.json`: a committed rival N/A stands over the weekly run's
  outcome until the next run writes it. Never
  mark N/A to hide a failure.
- **A harness bug is fixed, not marked N/A** or skipped. If a rival fails
  because the adapter writes its config wrong, fix the adapter (use the
  idiom the tool's docs teach) and say so in the PR.
- **vx is always correct.** Never bend vx or the case to fit a rival. A
  case vx fails is a vx bug: fix vx in the same PR or first.
- **Forwarded args to many tasks are refused**; cases expect refusal. A
  single task forwards.
- **Flaky = fix it.** A case that passes on retry has a race in the case,
  adapter or tool: find it (README: watch phases settle after 8 s quiet,
  `inFlight` judges at once). Never add retries or loosen `within` to hide it.
- Read a rival's behaviour off its real binary, never by reasoning
  (`packages/vx/docs/history/lessons.md`).

## Run it

Needs `bwrap` (the suite refuses without it). From
`private/vx-conformance`:

```sh
bun src/cli.ts --case <id-or-prefix> --tool vx --verbose
bun src/cli.ts --case <id-or-prefix> --out case.json   # every tool
```

Run it for every tool before the PR, and run vx at least twice to see it
is stable. Then:

- Merge the new rows into `private/vx-docs/src/data/conformance.json`
  (`bun src/merge.ts`, or patch rows and recompute scores) so the site
  shows the case (`private/vx-docs/tests/conformance.test.ts` needs every
  case there).
- `bun test` in `private/vx-conformance` (inventory, refs) and
  `bun test tests/conformance.test.ts` in `private/vx-docs`.

## Sharding

CI (`.github/workflows/conformance.yml`) runs one job per tool and share
(`--shard i/n`, sized to about 90 s each: vx 6, turbo 4, nx 14, vite-task
2, nix 5, moon 42), weekly on every rival's latest, then
`conformance.cases.merge` joins them. A case that slows a tool's suite past its
share's 5-minute limit means raising that tool's count in the plan step's
`jq` line in the same PR. Locally: `--shard 1/3 --out a.json`, then
`bun src/merge.ts out.json a.json b.json c.json`.

## PR

Conventional title, e.g. `test(vx-conformance): add <slug> case`. Body:
the case id, where it came from (rival issue/commit, hardening find), and
each tool's outcome.
