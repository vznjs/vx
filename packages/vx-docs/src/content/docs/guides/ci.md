---
title: CI and remote
description: Choose what a run covers, run only what a change affects in CI, share the cache between machines, and send tasks to a worker pool.
# The job summary sample below carries its own headings; a table of contents
# would list them as this page's sections.
tableOfContents: false
---

Run what a change touched, and reuse what another machine already built.

## Run and filter

`vx run build` runs `build` in the package you are in, and what it
depends on.

```bash
vx run build --all                     # every package that has build
vx run build --filter "@app/*"         # packages whose name matches
vx run build --filter "...@app/ui"     # a package and everything that depends on it
vx run test --affected                 # changed since the base branch, and dependents
vx run test --affected=origin/main     # changed since that ref
vx run app#build api#test              # exact tasks, from anywhere
vx run lint test build --all           # several tasks, one graph
vx run test --all -- --bail            # the child runs: bun test --bail; the key sees it
vx run build --all --dry               # the plan, nothing runs
vx run build --all --graph=g.dot       # the task graph as Graphviz DOT
vx watch test --all                    # re-run whenever its files change
```

`--dry` prints what would run and where each result would come from:

```text
would run:
  ◉  @acme/api#build  cache hit (local)         8625b603
  ◉  @acme/ui#build   cache hit (local)         71e5d9a0
  ◉  @acme/web#build  cache hit (local)         42e9b39d

3 task(s) planned, 3 cache hits (3 local).
```

| Flag                | Does                                                        |
| ------------------- | ----------------------------------------------------------- |
| `--no-cache`        | ignore the cache: no reads, no writes                       |
| `--force`           | run everything, then refresh the cache                      |
| `--concurrency <n>` | at most n tasks at once (default: the cores you may use)    |
| `--continue`        | keep going after a failure ([modes](../configure/#tasks-and-dependencies)) |
| `--output-logs <m>` | `full`, `errors-only`, `hash-only` or `none`                |
| `--summarize`       | write a JSON summary of the run                             |
| `--frozen`          | load the configs from `vx-lock.json` ([below](#a-frozen-graph)) |

Every flag: [the CLI reference](../../cli/).

## GitHub Actions

Check out with `fetch-depth: 0`: `--affected` needs the history. Its base
is the target branch on a pull request, the commit before the push on a
push.

```yaml
# .github/workflows/ci.yml
on:
  pull_request:
  push:
    branches: [main] # a new branch's first push has no `before`
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read # checkout; naming any permission drops the rest
      checks: write # the PR check; the job summary needs nothing
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2 # the runner has no Bun
      - run: npm install -g @vzn/vx
      - run: bun install --frozen-lockfile
      - run: >
          vx run ci
          --affected=${{ github.event_name == 'pull_request'
            && format('origin/{0}', github.base_ref)
            || github.event.before }}
        env:
          GITHUB_TOKEN: ${{ github.token }} # the PR check; without it, no check
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-github'

export default defineWorkspace({ plugins: [github()] })
```

`github()` writes a job summary, failures first, and a PR check. The
check needs `GITHUB_TOKEN` in the vx step's `env`, as above (the runner
sets `GITHUB_REPOSITORY` and `GITHUB_SHA`); without it the check is
skipped and the summary still writes. Outside GitHub Actions it declines.
A test renders this sample:

> ## ❌ vx run
>
> **5** tasks · **2** executed · **2** cache hits (1 up-to-date, 1 restored, 1 from remote) · **1** failed · 21.4s
>
> ### Failures
>
> - **@acme/web#build** — exit 2
>
> | Task | Status | Duration |
> | --- | --- | --- |
> | @acme/web#build | ❌ failed | 3.1s |
> | @acme/web#test | ✅ ran | 4.2s |
> | @acme/api#build | ☁️ restored remote | 0ms |
> | @acme/ui#build | ✔️ up-to-date | 0ms |
> | @acme/ui#lint | ⏭️ skipped | 0ms |
>
> <sub>vx 0.0.21 · `vx run ci --all` · 3/5 passed · 1 up-to-date · 1 restored</sub>

A failure on inputs that passed before is named under the run's footer:

```
  Flaky:    1 task with the same inputs both passing and failing on record
    ✗ web#test — failed on inputs that passed 3× before
```

### A frozen graph

`vx lock` writes each project's resolved config, with a hash of its
config file, to `vx-lock.json`; commit it. `vx run ci --frozen` loads the
configs from the lock instead of evaluating them, and builds the graph
from them as usual. A frozen run trusts the lock and checks nothing:
`vx lock --check` fails on drift, so run it in CI too. It buys
determinism, not speed: on the 1,000-project bench a plain run's median
of 177 ms against frozen's 165 is a tie.

### Common problems

- **`--affected has no base here … a shallow clone?`** Set `fetch-depth: 0`.
- **`nothing affected since <ref>` on every push.** `origin/main` on a push to `main` is the commit itself. Use `github.event.before`.
- **The whole log lands in the job summary.** Use `--report-file="$GITHUB_STEP_SUMMARY"`, not a `>>` redirect.

## Remote cache

A shared cache is a plugin. vx looks here, then asks the remote, and
uploads new results in the background.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [reapi({ endpoint: 'grpcs://cache.example.com:443' })], // or VX_REAPI_ENDPOINT
})
```

`@vzn/vx-reapi` speaks Bazel's Remote Execution API (NativeLink,
BuildBuddy, Buildbarn, bazel-remote). It re-hashes every blob it reads: a
corrupt download, a down server or a refused token is a miss, never wrong
bytes. With no endpoint, it declines.

`turboCache()` from `@vzn/vx-migrate` keeps a Turborepo cache, Vercel's
included, and reads Turbo's own variables:

```sh
bun add -d @vzn/vx-migrate
npx turbo login && npx turbo link        # stores a token and a team
export TURBO_TOKEN=… TURBO_TEAM=…
```

Then declare `plugins: [turboCache()]`. `nxCache()` does the same for a
self-hosted Nx cache; your own backend is [a plugin](../plugins/#your-own-cache).
A laptop that only reads runs with `--cache=local:rw,remote:r`; so does a
pull request from a fork, which must never write what `main` restores.
The plugins honour the tools' own switches for it too: Turbo's
`TURBO_REMOTE_CACHE_READ_ONLY` and `TURBO_CACHE`, Nx's
`NX_SKIP_REMOTE_CACHE`.

## Remote execution

`reapi()` can also send tasks to a worker pool (NativeLink, BuildBuddy,
Buildfarm); the graph and the scheduling stay here. It is never on by
default:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [
    reapi({
      endpoint: 'grpcs://cache.example.com:443',
      execute: true, // or VX_REAPI_EXECUTE=1
      platform: { OSFamily: 'Linux', 'container-image': 'docker://node:22' },
      capacity: 64, // remote tasks at once, apart from your cores
    }),
  ],
})
```

`--dry` says where each task runs (`@vx/reapi` or `@local`).
`exec.remote: false`, sandboxed and persistent tasks, and what depends on
them, stay here. A task with no `cache` block stays here too, because the
executor declines it, but what depends on it can still go remote. Workers have no `node_modules`: make
the install a `remote: 'only'` task the others depend on. The image needs
`/bin/sh` and your toolchain.

A worker gets only what `cache.inputs` declares, so a task that fails
there and passes here reads a file it never declared.

- A down server is a cache miss, never a hung run.
- Uploads chunk at 65535 bytes (`SAFE_CHUNK_BYTES`), the size no Bun http2
  stall has been seen at. A larger `chunkBytes` that stalls retries once at
  that size before the task fails.
