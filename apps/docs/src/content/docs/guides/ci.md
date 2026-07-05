---
title: Continuous integration
description: Run vx in CI — install the binary, build only what changed with --affected, share a cache by connecting a vx-cloud, and (optionally) pin a reproducible run with vx lock + --frozen.
---

vx is built for CI: a content-addressed cache plus `--affected` selection
means most pull requests execute only the packages they actually touched
and restore everything else from a previous build. This guide is a working
setup you can copy, plus the lockfile workflow and when to reach for it.

## The shape of a fast CI run

1. **Install vx** (a single binary) and your workspace dependencies.
2. **Connect a vx-cloud** so this run shares a cache with previous runs and
   teammates. One connection (`VX_CLOUD_URL` + `VX_CLOUD_TOKEN`) provides
   the remote cache — no separate cache config. (No server? The local cache
   still makes warm runs instant; a shared cache is only needed to reuse
   work *across* machines.)
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
      # The one connection: cache + dashboard from a single vx-cloud.
      VX_CLOUD_URL: ${{ secrets.VX_CLOUD_URL }}
      VX_CLOUD_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
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
- **`vx` is the curl-installed binary** on `PATH` — no wrapper needed. (Or
  install it as a dependency with `bun add -d @vzn/vx` and invoke it
  through your package manager.)
- **Pin the version** with `VX_VERSION=<tag>` before the install line for
  byte-stable CI.
- **Connection secrets** as `env` — `VX_CLOUD_URL` + `VX_CLOUD_TOKEN` point
  this run at a shared cache (and the dashboard). With them set, the run
  reuses artifacts built on other branches and machines. See
  [Remote caching](../remote-caching/). On a fork PR, present
  `VX_CLOUD_PR_TOKEN` instead of `VX_CLOUD_TOKEN`: it warms off the trusted
  cache but can only write the untrusted scope, so it can't poison a trusted
  build. (Prefer a third-party Turbo-compatible cache server? Use
  `VX_REMOTE_CACHE_URL` + `VX_REMOTE_CACHE_TOKEN` instead — same guide.)

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

Declare the [`cloud()` plugin](../extensibility/) in your
`vx.workspace.ts` and every `vx run` inside GitHub Actions appends a
per-task result table (failures first, with exit codes) to the job's
summary page — so a red build tells you *which* task failed without
opening the raw log. It works with **no serve connected** (the summary
is formatted from the run locally, from the `$GITHUB_STEP_SUMMARY` file
Actions provides) and needs no extra workflow step. A plain local run —
not in Actions — writes nothing.

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
schedule or the merge queue, not every push. When the `cloud()` plugin is
active, the job-summary page gains a **Hermeticity** line
(`🔒 Hermeticity: N proven · M non-deterministic`) and each non-hermetic
task is flagged inline with its diverging outputs.
`--verify-allow=<pkg#task,…>` exempts tasks you can't fix yet so the gate
stays green on the rest. See the
[CLI reference](../../cli/#provable-cache-correctness-verify).

## Next steps

- **[Remote caching](../remote-caching/)** — set up the shared cache.
- **[Running & filtering tasks](../running-tasks/)** — `--affected`,
  filters, and `--frozen` in depth.
- **[CLI reference](../../cli/)** — every flag and exit code.
