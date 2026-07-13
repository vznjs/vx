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
   teammates already built. Sharing is a plugin — the first-party option
   is a self-hosted platform (see the [Cloud section](../../cloud/overview/)),
   and any other backend plugs in the same way (see
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
    # cache's connection secrets here (see the Cloud section).
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
  of executing). The first-party option is a self-hosted platform with a
  trust-scoped cache and fork-PR tokens; its CI wiring lives in the
  [Cloud section](../../cloud/remote-caching/). Any other backend plugs in
  through a cache plugin — see [Remote caching](../remote-caching/) and
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

vx can append a per-task result table (failures first, with exit codes) to
the job's summary page, so a red build tells you *which* task failed
without opening the raw log. Two ways:

- **Core, one flag.** `vx run ci --report=markdown >> "$GITHUB_STEP_SUMMARY"`
  writes the table from the run's own outcomes — no plugin, no server.
- **Automatic.** The first-party CI telemetry plugin appends the summary on
  every `vx run` inside Actions (and adds PR checks, below) with **no
  server connected** — the summary is formatted locally from the
  `$GITHUB_STEP_SUMMARY` file Actions provides, with no extra workflow step.
  See the [Cloud section](../../cloud/overview/).

## PR checks (GitHub Checks API)

The job summary lives on the *job* page; to surface the same result in the
**PR's checks list** — a named check with a pass/fail conclusion and the
per-task table as its detail — declare the first-party CI plugin and hand
the workflow token to the vx step:

```yaml
permissions:
  checks: write

steps:
  - run: vx run ci
    env:
      GITHUB_TOKEN: ${{ github.token }}
```

Passing the token **is** the opt-in (Actions never exposes it to a step by
itself). After the run, vx creates one completed check run on the commit —
for `pull_request` events it attaches to the PR's *head* SHA (read from the
event payload), so the check shows on the PR rather than the synthetic merge
commit. Conclusion mirrors the run: green when every task passed, red
otherwise, with the same failures-first table as the job summary.

Knobs: `VX_GITHUB_CHECK=0` disables it; `VX_GITHUB_CHECK_NAME` overrides the
check's name (default: the run's command). A missing `checks: write`
permission warns and never fails the run — like every vx telemetry surface,
it is observe-only.

## Proving cache correctness: `vx run --verify`

Every cache assumes a task run twice on the same inputs produces the same
bytes. A task that bakes in a timestamp, an unsorted map, or a random seed
breaks that assumption silently — its cache entry replays arbitrary past
output forever. `--verify` proves it instead of hoping: after each executed
cacheable task saves, vx re-runs it and content-compares the outputs. A
non-deterministic task fails the run, naming the diverging paths.

```yaml
- name: Verify cache correctness (nightly / merge queue)
  run: vx run build --all --force --verify
```

`--force` re-executes a warm graph so every task is verified (a plain
`--verify` run cache-hits and reports `not-verified` — there's nothing to
re-run). It costs roughly 2× execution for verified tasks, so run it on a
schedule or the merge queue, not every push.

`--verify=inputs` proves the *other* half of cache safety — that the
inputs you declared are the whole read set. It runs each task once through
vx's OS sandbox with the declared inputs as the only readable workspace
paths and fails the run naming any undeclared read. `--verify=all` runs
both proofs. (`inputs`/`all` need the OS sandbox on the runner; GitHub's
`ubuntu-latest` provides bwrap + strace.)

When the first-party CI telemetry plugin is active, the job-summary page
gains a **Hermeticity** line
(`🔒 Hermeticity: N proven · M non-deterministic`) and each non-hermetic
task is flagged inline with its diverging outputs.
`--verify-allow=<pkg#task,…>` exempts tasks you can't fix yet so the gate
stays green on the rest. See the
[CLI reference](../../cli/#provable-cache-correctness-verify).

### Cross-machine determinism: `--verify=fingerprint`

A single-machine `--verify` can't see a task that is deterministic
per-machine but **platform-dependent** — one that embeds `process.arch`
or an absolute build path. With a shared remote cache such a task
poisons the cache silently: the cache key folds no os/arch, so the first
platform to write wins and the other restores wrong bytes forever.

`--verify=fingerprint` closes that gap: it fingerprints each executed
task's output tree (~1× execution plus a hash pass — no re-run) and
ships the fingerprint with the run's telemetry. A connected analytics
service pairs fingerprints for the same cache key across platforms and
names exactly which output files diverge — the first-party one surfaces
this on its dashboard's Insights **Hermeticity** card (see the
[Cloud section](../../cloud/overview/)). Run it on the same per-platform
matrix that builds your release binaries, with a shared cache connected so
each platform reports:

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
steps:
  # Connect a shared cache + analytics service here (see the Cloud section)
  # so the fingerprints from every platform land in one place.
  - run: vx run --all --force --verify=fingerprint
```

`--force` matters: with plain reads the second platform would cache-hit
and never execute — exactly the poisoning scenario — so it would never
produce a fingerprint. Teams already running the nightly
`--force --verify` recipe get cross-machine data for free (the
determinism proof computes the fingerprint anyway). A flagged key means
either a hermeticity bug to fix, or a genuinely platform-dependent task
whose key should split per platform — declare
`cache.inputs.runtime: ['uname -sm']`.

## Next steps

- **[Remote caching](../remote-caching/)** — set up the shared cache.
- **[Running & filtering tasks](../running-tasks/)** — `--affected`,
  filters, and `--frozen` in depth.
- **[CLI reference](../../cli/)** — every flag and exit code.
