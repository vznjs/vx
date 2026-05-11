---
name: local-ci
description: Run the same checks CI runs, in the same order. Use before every push to catch failures locally instead of waiting for the GitHub Actions feedback loop.
---

# Run local CI

Reproduces the GitHub Actions workflow `.github/workflows/ci.yml`
locally, in order. Fail fast.

```sh
bun install --frozen-lockfile && \
bun run format:check && \
bun run lint && \
bun test src/
```

## What each step covers

- **`bun install --frozen-lockfile`** — verifies the lockfile is in
  sync with `package.json`. Skipping the `--frozen-lockfile` flag
  hides desync.
- **`bun run format:check`** — `oxfmt --check .` against every file
  prettier-style globs would match, minus `.oxfmtrc.json`
  `ignorePatterns`.
- **`bun run lint`** — `oxlint --type-aware --type-check`. The
  `--type-check` flag invokes `tsgolint` for real TypeScript
  diagnostics. This is our typechecker; tsc is gone.
- **`bun test src/`** — the bun-native test runner. Recognizes vitest
  test files via Bun's compat layer.

## If any step fails

- **format**: `bun run format` to fix.
- **lint**: `bun run lint:fix` for autofixes; manual review for the rest.
- **test**: usual triage; existing test fixtures in
  `src/*.test.ts` use heredoc-string `vzn.config.mjs` content.
