---
name: local-ci
description: Run the same checks CI runs, in the same order. Use before every push to catch failures locally instead of waiting for the GitHub Actions feedback loop.
---

# Run local CI

Reproduces the GitHub Actions workflow `.github/workflows/ci.yml`
locally. CI has TWO jobs; run both. Fail fast.

**Run the underlying commands directly, NOT the cached `vx run ci`
gate.** A CI runner has no vx cache; locally, `lint.oxlint` /
`lint.oxfmt` can CACHE-HIT a stale result and mask a real failure
(this shipped a red main once — see the 2026-07-15 decision-log
lesson). The raw commands are cache-proof.

```sh
# job 1: lint · format · test (what `vx run ci` fans out to)
bun install --frozen-lockfile && \
bunx oxfmt --check . && \
bunx oxlint --type-aware --type-check && \
bun test ./tests/

# job 2: vx-cloud tests (real ephemeral Postgres + fake S3)
rm -rf /tmp/vx-test-pg-*   # stale ephemeral-pg dirs fill the disk
(cd packages/cloud && bun test --timeout 30000)
```

## What each step covers

- **`bun install --frozen-lockfile`** — verifies the lockfile is in
  sync with `package.json`. Skipping the `--frozen-lockfile` flag
  hides desync.
- **`bunx oxfmt --check .`** — format check on every file minus
  `.oxfmtrc.json` `ignorePatterns`. Note the vx `lint.oxfmt` task's
  cache inputs include `**/*`, but a stale hit is still possible when
  only out-of-glob state changed — the raw command never lies.
- **`bunx oxlint --type-aware --type-check`** — oxlint + tsgolint
  (real TypeScript diagnostics). This is our typechecker; tsc is only
  used by the UI package's own build.
- **`bun test ./tests/`** — the core suite. The `./` anchor keeps the
  scan out of `packages/*/tests/`.
- **cloud `bun test`** — the platform suite. Boots its own ephemeral
  Postgres cluster per process; ALWAYS `rm -rf /tmp/vx-test-pg-*`
  first or leftover clusters exhaust the disk.

## Known load-dependent flakes (verify in isolation before blaming your change)

- `tests/cache-baseline.test.ts` perf guards and the `vx watch` e2e in
  `tests/cli.test.ts` can fail under concurrent machine load; both
  pass in isolation on a healthy tree.
- Running the two cloud pg suites concurrently can hit initdb/
  connection-slot contention — rerun the failing file alone.

## If any step fails

- **format**: `bunx oxfmt .` rewrites (or `bun src/bin.ts run
lint.oxfmt.fix` through vx).
- **lint**: fix by hand; tsgolint findings are real type errors.
- **test**: usual triage; core e2e fixtures write heredoc-string
  `vx.config.mjs` files.

## After pushing

The local gate passing is NOT the same as CI green — confirm the
actual run's conclusion (`gh`/MCP `actions_list` on `ci.yml` for your
sha) before building on top of the push.
