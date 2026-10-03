# @vzn/vx-github

GitHub Actions integration for [`@vzn/vx`](https://github.com/vznjs/vx) — a
telemetry plugin that writes every `vx run` as a **job summary** on the
workflow run page.

```sh
npm install -D @vzn/vx @vzn/vx-github   # or: pnpm add -D -w · yarn add -D (-W on Yarn 1) · bun add -d
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-github'

export default defineWorkspace({
  plugins: [github()],
})
```

That's the whole setup. On a GitHub Actions runner (`GITHUB_STEP_SUMMARY`
set) every `vx run` appends a summary block, on its own line after
anything already written in the step: verdict headline, stats
(tasks / executed / cache hits / duration), failures called out above the
per-task table with their exit code, the signal an exit above 128
stands for (`exit 137 (128 + SIGKILL)`, as the run's own frame and
`vx last` say it), a timeout as `timed out, exit 143`, a persistent task
that never became ready as `never ready (timed out)`, a sandboxed task's
violation count, and the tasks each failure blocked. A footer line
names the vx version, the command (what follows `--` counted, not
quoted), tasks passed and outputs restored.
Anywhere else — laptops, other CI — the plugin **declines** and costs
nothing, so declaring it unconditionally is safe.

## Options

The options type is `GithubPluginOptions`; `renderJobSummary` renders the
summary lines the plugin posts (the site's CI guide sample is rendered from it).
The package exports `github`, `renderJobSummary` and the types `GithubPluginOptions`
and `FetchFn`; nothing else. `fetchFn`, `append` and `sizeOf` are test seams:
they replace the Checks API transport, the summary writer and its size probe.

```ts
github({
  summaryFile: '/path/override.md', // default: $GITHUB_STEP_SUMMARY
  title: 'build & test', // default: 'vx run'
  checks: true, // default: on with GITHUB_TOKEN; true warns when it is missing, false opts out
  checkName: 'ci', // default: 'vx', the check run's name
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
**completed check-run** on the built commit — conclusion `success`,
`failure`, or `cancelled` for a run a signal stopped with nothing
failed (a cancelled job), its output the same summary markdown — so the verdict shows in
the PR's checks list, not just the workflow page. The workflow must grant
the permission:

```yaml
permissions:
  checks: write
```

Without the token the check is silently skipped (the job summary still
writes); pass `checks: true` to warn instead, or `checks: false` to opt
out entirely; a value that is not a boolean is refused. GitHub's own blips (`502`, `503`, `504`, a dropped
connection) are retried twice, 200 then 800 ms apart, until the flush deadline, which warns the last answer. A failed POST warns and never fails the run — a `403` says
to check `permissions: checks: write`, a rate limit (`429`, or a `403`
saying so) says so and is not retried — and a slow API costs the run
nothing past core's end-of-run flush deadline. On `pull_request` events
`GITHUB_SHA` is the merge commit; GitHub still surfaces the check on the
PR.

On GitHub Enterprise Server the POST goes to `GITHUB_API_URL`. A host
behind a private CA is trusted through `NODE_EXTRA_CA_CERTS` (a PEM
file of the CA); an untrusted certificate is not retried and its warning
names that variable.

Both artifacts are bounded by GitHub's own limits, because exceeding
either loses the whole thing rather than its tail: the check-run output
at 65 535 bytes, the job summary at 1 MiB counted in bytes (about 19 000 task rows; fewer when task names are not ASCII), cut on a character boundary. GitHub's cap is the step's whole summary file, so the page fits in what earlier writers in the step left; with no room it is skipped with a warning.
Past either, what is written ends with a line saying it was truncated.
