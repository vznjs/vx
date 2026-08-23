---
name: local-ci
description: Run the same checks CI runs, in the same order. Use before every push to catch failures locally instead of waiting for the GitHub Actions feedback loop.
---

# Run local CI

Reproduces the GitHub Actions workflow `.github/workflows/ci.yml`
locally. Fail fast.

**Run the underlying commands directly, NOT the cached `vx run ci`
gate.** A CI runner has no vx cache; locally, `lint.oxlint` /
`lint.oxfmt` can CACHE-HIT a stale result and mask a real failure
(this shipped a red main once — see the 2026-07-15 decision-log
lesson). The raw commands are cache-proof.

```sh
# lint · format · test (what `vx run ci` fans out to)
bun install --frozen-lockfile && \
bunx oxfmt --check . && \
bunx oxlint --type-aware --type-check && \
bun test ./tests/
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

## Known load-dependent flakes (verify in isolation before blaming your change)

- `tests/cache-baseline.test.ts` perf guards and the `vx watch` e2e in
  `tests/cli.test.ts` can fail under concurrent machine load; both
  pass in isolation on a healthy tree.
- The sandbox suites skip without `bwrap`/`socat`/`strace`; CI sets
  `VX_REQUIRE_SANDBOX=1` so an unavailable sandbox FAILS there instead
  of silently passing.

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
