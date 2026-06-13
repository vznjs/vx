---
title: Continuous integration
description: Run vx in CI — a complete GitHub Actions example with remote caching and --affected so most pull requests only build what they changed.
---

vx is built for CI: a content-addressed cache plus `--affected` selection
means most pull requests execute only the packages they actually touched
and restore everything else from a previous build. This guide is a
working setup you can copy.

## The shape of a fast CI run

1. **Install** dependencies.
2. Point vx at a **remote cache** (so this run sees what previous runs and
   teammates built).
3. Run with **`--affected`** so only changed packages execute.

## GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      VX_REMOTE_CACHE_URL: ${{ secrets.VX_REMOTE_CACHE_URL }}
      VX_REMOTE_CACHE_TOKEN: ${{ secrets.VX_REMOTE_CACHE_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # --affected needs git history to diff

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - name: Lint, test, build what changed
        run: bun x vx run lint test build --affected=origin/${{ github.base_ref || 'main' }}
```

Notes:

- **`fetch-depth: 0`** — `--affected` diffs against a base ref, which
  needs real git history. A shallow clone can't compute it.
- **`--affected=origin/<base>`** — on a PR, diff against the target
  branch; on a push to `main`, fall back to `main`. Packages with changes
  (and their dependents) run; the rest restore from cache.
- **Remote cache secrets** as `env` — see
  [Remote caching](../remote-caching/). With them set, this run reuses
  artifacts built on other branches and machines.

## Without `--affected`

If you'd rather always run the whole workspace and lean entirely on the
cache (simpler, still fast once warm):

```yaml
      - run: bun x vx run lint test build --all
```

With remote caching, an unchanged package is a cache hit even here — it
just enumerates and restores instead of executing.

## Dogfooding tip: a `ci` group task

Define a group task so CI has one entry point and the gate is declared in
config, not the workflow:

```ts
ci: {
  description: 'format-check + lint + test',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

```yaml
      - run: bun x vx run ci --all
```

## Reproducible CI with a lockfile (optional)

For builds that must be bit-for-bit reproducible, commit a resolved
config lockfile and have CI run from it:

```bash
vx lock                 # freeze the resolved task graph into vx-lock.json
vx lock --check         # CI: re-evaluate and assert nothing drifted
vx run ci --all --frozen   # execute exactly the locked config, no eval
```

`--frozen` runs entirely from `vx-lock.json` with zero config evaluation,
while local development always evaluates live. This gives you
code-as-config *and* reproducibility — something Turborepo and Nx sidestep
by being less expressive.

## Run summaries and profiles

For dashboards or debugging a slow pipeline:

```bash
vx run build --all --summarize=summary.json   # per-task JSON
vx run build --all --profile=trace.json        # Chrome-trace timeline
```

## Next steps

- **[Remote caching](../remote-caching/)** — set up the shared cache.
- **[Running & filtering tasks](../running-tasks/)** — `--affected` and
  filters in depth.
- **[CLI reference](../../cli/)** — every flag and exit code.
