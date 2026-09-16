# @vzn/vx-github

GitHub Actions integration for [`@vzn/vx`](https://github.com/vznjs/vx) — a
telemetry plugin that writes every `vx run` as a **job summary** on the
workflow run page.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-github'

export default defineWorkspace({
  plugins: [github()],
})
```

That's the whole setup. On a GitHub Actions runner (`GITHUB_STEP_SUMMARY`
set) every `vx run` appends a summary block: verdict headline, stats
(tasks / executed / cache hits / duration), failures called out above the
per-task table with their exit code, the signal an exit above 128
stands for (`exit 137 (128 + SIGKILL)`, as the run's own frame and
`vx last` say it), a timeout as `timed out, exit 143`, a persistent task
that never became ready as `never ready (timed out)`, a sandboxed task's
violation count, and the tasks each failure blocked.
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
