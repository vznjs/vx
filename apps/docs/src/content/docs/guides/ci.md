---
title: Continuous integration
description: Run vx in CI — install the binary, build only what changed with --affected, share a cache by connecting a remote-cache backend, and (optionally) pin a reproducible run with vx lock + --frozen.
---

vx is built for CI: a content-addressed cache plus `--affected` selection
means most pull requests execute only the packages they actually touched
and restore everything else from a previous build. This guide is a working
setup you can copy, plus the lockfile workflow and when to reach for it.

## The shape of a fast CI run

1. **Install vx** (a single binary) and your workspace dependencies.
2. **Connect a shared cache** so this run reuses what previous runs and
   teammates already built. Sharing is a plugin — `@vzn/vx-reapi` connects
   any Bazel REAPI server (NativeLink, BuildBuddy, Buildbarn,
   bazel-remote), and any other backend plugs in the same way (see
   [Remote caching](../remote-caching/)). (No server? The local cache still
   makes warm runs instant; a shared cache is only needed to reuse work
   *across* machines.)
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
    # Connecting a shared cache is optional — the local cache already makes
    # warm runs fast. To reuse artifacts across machines, add the shared
    # cache plugin's connection secrets here.
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --affected diffs against a base ref → needs history

      # Install the vx binary onto PATH. Pin the version for reproducible CI.
      - name: Install vx
        run: npm install -g @vzn/vx

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
- **`vx` is the npm-installed binary** on `PATH` — no wrapper needed. (Or
  install it as a dependency with `bun add -d @vzn/vx` and invoke it
  through your package manager.)
- **Pin the version** with `npm install -g @vzn/vx@<version>` for
  byte-stable CI.
- **Shared cache** — connect a remote-cache backend to reuse artifacts
  built on other branches and machines (unchanged packages restore instead
  of executing). `@vzn/vx-reapi` connects any Bazel REAPI server; any other
  backend plugs in through a cache plugin — see
  [Remote caching](../remote-caching/) and
  [Core is provider-neutral](../extensibility/).

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

## GitHub Actions job summary

vx can append a per-task result table to the job's summary page, so a red
build tells you *which* task failed without opening the raw log. Failures
are sorted to the **top**, each with its exit code and cache provenance —
so the one thing you opened the summary to find is the first thing you
see. GitHub renders it as markdown right on the job page:

> ### vx run — `vx run ci --all`
>
> ❌ failed · **5** tasks · **1** failed · **2** cache hits · **2** executed · **1** skipped · 21.4s
>
> | Task | Status | Duration | Cache |
> | --- | --- | ---: | --- |
> | `@acme/web#build` | ❌ failed (exit 2) | 3.1s | miss |
> | `@acme/web#test` | ✅ success | 4.2s | miss |
> | `@acme/api#build` | 🟦 cache hit | 0ms | remote |
> | `@acme/ui#build` | 🟦 cache hit | 0ms | local |
> | `@acme/ui#lint` | ⚪ skipped | 0ms | — |

Every task is in exactly one bucket: `cache hits + executed + skipped` is
the task count. A **skipped** task is one whose dependency failed — under
the default `--continue=deps-ok` a single broken leaf skips everything
downstream — so it is counted and named, never folded into "executed".
`skipped` and `aborted` appear only when non-zero.

Two ways to get it:

- **Core, one flag.** `vx run ci --report-file="$GITHUB_STEP_SUMMARY"`
  writes the table from the run's own outcomes — no plugin, no server.
  Use `--report-file`, not `--report=markdown >> …`: the report is
  machine-clean but stdout is shared with vx's own run output, so a
  redirect puts the whole log in the summary above the table.
The automatic variant — a telemetry plugin that appended the summary on
every `vx run` inside Actions with no extra workflow step — shipped in the
removed cloud package. `@vzn/vx-github` will carry it; until then
`--report-file` is the supported path and needs no plugin at all.

## PR checks (GitHub Checks API)

A `vx run` result as a real check run on the PR — with per-task
annotations and failure triage (**🎲 flaky** / **📌 already broken on the
default branch** / **🆕 new failure**) — shipped as part of the removed
cloud package. It is planned as `@vzn/vx-github`, a telemetry plugin
needing only `GITHUB_TOKEN` and `checks: write`. Until it lands, the job
summary above is the PR-visible surface.

## Next steps

- **[Remote caching](../remote-caching/)** — set up the shared cache.
- **[Running & filtering tasks](../running-tasks/)** — `--affected`,
  filters, and `--frozen` in depth.
- **[CLI reference](../../cli/)** — every flag and exit code.
