---
title: Continuous integration
description: Run only what a change affects in CI, share the cache between runs, and get a job summary and a PR check from @vzn/vx-github.
---

Build only what a change touched, and reuse what another run already built.
Why? → [Chapter 7: Only what changed](../../guide/affected/) and
[Chapter 8: Many machines](../../guide/many-machines/)

## Steps

1. Check out with `fetch-depth: 0`: `--affected` needs the history.
2. Install a pinned vx: `npm install -g @vzn/vx@<version>`.
3. Run `vx run ci --affected=<base>`: the target branch on a PR, the commit before the push on a push.
4. To reuse results across machines, declare a [remote cache](../remote-caching/).
5. For a job summary and a PR check, declare `github()` from `@vzn/vx-github`.

## Config

```yaml
# .github/workflows/ci.yml
on: [pull_request, push]
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      checks: write # the PR check; the job summary needs nothing
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm install -g @vzn/vx
      - run: bun install --frozen-lockfile
      - run: >
          vx run ci
          --affected=${{ github.event_name == 'pull_request'
            && format('origin/{0}', github.base_ref)
            || github.event.before }}
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-github'

export default defineWorkspace({ plugins: [github()] })
```

Outside GitHub Actions, `github()` declines and costs nothing.

## What `@vzn/vx-github` writes

The job summary, failures first (a test renders this run and checks it
against this page):

> ## ❌ vx run
>
> **5** tasks · **2** executed · **2** cache hits (1 remote) · **1** failed · 21.4s
>
> ### Failures
>
> - **@acme/web#build** — exit 2
>
> | Task | Status | Duration |
> | --- | --- | --- |
> | @acme/web#build | ❌ failed | 3.1s |
> | @acme/web#test | ✅ ran | 4.2s |
> | @acme/api#build | ☁️ remote cache | 0ms |
> | @acme/ui#build | ⚡ cache | 0ms |
> | @acme/ui#lint | ⏭️ skipped | 0ms |
>
> <sub>vx 0.0.21 · `vx run ci --all` · 3/5 passed · 2 restored</sub>

A failure on inputs that passed before is named under the run's footer:

```
  Flaky:    1 task with the same inputs both passing and failing on record
    ✗ web#test — failed on inputs that passed 3× before
```

## A frozen graph

`vx lock` writes the resolved task graph to `vx-lock.json`; commit it.
In CI, `vx lock --check` fails if a config drifted, and
`vx run ci --frozen` runs exactly the locked graph. Take `--frozen` for
determinism, not speed: on the 1,000-project bench a plain run's median
of 177 ms against frozen's 165 is a tie.

## Common problems

- **`--affected has no base here … a shallow clone?`** The checkout has no history. Set `fetch-depth: 0`.
- **`nothing affected since <ref>` on every push.** `origin/main` on a push to `main` is the commit itself. Use `github.event.before`.
- **The whole log lands in the job summary.** Use `--report-file="$GITHUB_STEP_SUMMARY"`, not a `>>` redirect.
