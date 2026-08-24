# @vzn/vx-github

GitHub Actions integration for [`@vzn/vx`](https://github.com/vznjs/vx) — a
telemetry plugin that writes every `vx run` as a **job summary** on the
workflow run page.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { github } from '@vzn/vx-github'

export default defineWorkspace({
  plugins: [localExecutorPlugin(), localCachePlugin(), github()],
})
```

That's the whole setup. On a GitHub Actions runner (`GITHUB_STEP_SUMMARY`
set) every `vx run` appends a summary block: verdict headline, stats
(tasks / executed / cache hits / duration), failures called out above the
per-task table, and a `Verify` column when the run was a `--verify` proof.
Anywhere else — laptops, other CI — the plugin **declines** and costs
nothing, so declaring it unconditionally is safe.

## Options

```ts
github({
  summaryFile: '/path/override.md', // default: $GITHUB_STEP_SUMMARY
  title: 'build & test', // default: 'vx run'
})
```

## How it works

`github()` contributes one observe-only telemetry sink through vx's
`telemetry` seam. It receives the versioned `RunSummaryRecord` at run end
and renders + appends the markdown in `flush()` — it holds no run handle,
streams no per-event records (`wants: []`), and a slow or failing write can
never fail or stall the run (core's crash-isolation + flush deadline).

Core's manual path still exists without this plugin:
`vx run --report=markdown --report-file "$GITHUB_STEP_SUMMARY"` writes a
plain table. The plugin's summary is richer (verdict, stats, failure
callouts) and automatic on every run.

## The PR check run

With `GITHUB_TOKEN` in the environment (plus `GITHUB_REPOSITORY` /
`GITHUB_SHA`, both set by the runner) the plugin also creates one
**completed check-run** on the built commit — conclusion `success` /
`failure`, its output the same summary markdown — so the verdict shows in
the PR's checks list, not just the workflow page. The workflow must grant
the permission:

```yaml
permissions:
  checks: write
```

Without the token the check is silently skipped (the job summary still
writes); pass `checks: true` to warn instead, or `checks: false` to opt
out entirely. A failed POST warns and never fails the run. On
`pull_request` events `GITHUB_SHA` is the merge commit; GitHub still
surfaces the check on the PR.
