---
title: Continuous integration
description: Run vx in CI — install the binary, build only what changed with --affected, share a remote cache, and (optionally) pin a reproducible run with vx lock + --frozen.
---

vx is built for CI: a content-addressed cache plus `--affected` selection
means most pull requests execute only the packages they actually touched
and restore everything else from a previous build. This guide is a working
setup you can copy, plus the lockfile workflow and when to reach for it.

## The shape of a fast CI run

1. **Install vx** (a single binary) and your workspace dependencies.
2. Point vx at a **remote cache** so this run sees what previous runs and
   teammates already built.
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
          fetch-depth: 0 # --affected diffs against a base ref → needs history

      # Install the vx binary onto PATH. Pin VX_VERSION for reproducible CI.
      - name: Install vx
        run: |
          curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      # Install workspace dependencies with your package manager.
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile

      - name: Lint, test, build what changed
        run: vx run lint test build --affected=origin/${{ github.base_ref || 'main' }}
```

Notes:

- **`fetch-depth: 0`** — `--affected` diffs against a base ref, which
  needs real git history. A shallow clone can't compute it.
- **`--affected=origin/<base>`** — on a PR, diff against the target
  branch; on a push to `main`, fall back to `main`. Changed packages (and
  their dependents) run; the rest restore from cache.
- **`vx` is the curl-installed binary** on `PATH` — no `npx`/`bun x`
  needed. (An `@vzn/vx` npm package is coming soon; until then, install
  the binary as above.)
- **Pin the version** with `VX_VERSION=<tag>` before the install line for
  byte-stable CI.
- **Remote cache secrets** as `env` — see
  [Remote caching](../remote-caching/). With them set, this run reuses
  artifacts built on other branches and machines.

## Without `--affected`

Prefer to always run the whole workspace and lean entirely on the cache
(simpler, still fast once warm)?

```yaml
      - run: vx run lint test build --all
```

With remote caching an unchanged package is a cache hit even here — it
enumerates and restores instead of executing.

## One entry point: a `ci` group task

Declare the gate in config, not the workflow, with a group task:

```ts
ci: {
  description: 'format-check + lint + test',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

```yaml
      - run: vx run ci --all
```

## The lockfile: `vx lock` + `--frozen`

vx config is real TypeScript — it can `import` shared presets and read
`process.env`. That power means a config's *evaluated* result can, in
principle, differ between machines. The lockfile makes a run **frozen and
reproducible**: `vx lock` evaluates every project config once and writes
the fully-resolved task graph to `vx-lock.json`; `vx run --frozen` then
executes from that file with **zero config evaluation**.

```bash
vx lock                    # freeze the resolved graph → vx-lock.json (commit it)
vx lock --check            # re-evaluate and assert nothing drifted (exit 1 if it did)
vx run ci --all --frozen   # execute exactly the locked graph, no eval
```

Three commands, three jobs:

- **`vx lock`** — regenerate the lockfile. Run it whenever you change a
  `vx.config.ts` (or a preset it imports) and **commit `vx-lock.json`**
  alongside the change.
- **`vx lock --check`** — an audit. It re-evaluates every config in the
  current environment and compares against the committed lock, catching
  drift a file-hash can't see (e.g. a config that reads `process.env`).
  Great as a CI step or a pre-commit hook.
- **`vx run --frozen`** — load configs straight from `vx-lock.json` (after
  a hash tripwire) and run. A stale or missing lock is a hard error, never
  a silent fall back to live evaluation.

### When should you use it?

- **In CI: yes, when you want determinism.** `--frozen` guarantees the run
  executes the exact graph you committed — no eval-time surprises from a
  different Node/Bun, env, or a transitively-imported preset. It's also
  **faster**: skipping the per-run config re-parse trims roughly **10–21%**
  off warm runs (the bigger your workspace, the more it saves). Pair it
  with a `vx lock --check` step so CI fails loudly if someone forgot to
  re-lock.
- **Locally: no — keep evaluating live.** Day-to-day `vx run` always reads
  your configs fresh, so edits take effect immediately. `--frozen` is for
  the reproducible/CI path, not the inner loop.
- **Skip it entirely** if you don't need bit-for-bit reproducibility — the
  cache makes runs fast without it, and plain `vx run` is the default.

Turborepo and Nx have no equivalent: their static-JSON configs dodge the
problem by being less expressive. vx keeps code-as-config **and**
reproducibility.

## Run summaries and profiles

For dashboards or debugging a slow pipeline:

```bash
vx run build --all --summarize=summary.json   # per-task JSON
vx run build --all --profile=trace.json       # Chrome-trace timeline
```

## Next steps

- **[Remote caching](../remote-caching/)** — set up the shared cache.
- **[Running & filtering tasks](../running-tasks/)** — `--affected`,
  filters, and `--frozen` in depth.
- **[CLI reference](../../cli/)** — every flag and exit code.
