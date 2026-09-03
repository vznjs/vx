# @vzn/vx-otel

The OpenTelemetry exporter plugin for [`@vzn/vx`](https://github.com/vznjs/vx).
Maps each `vx run` to **OTLP traces + metrics** over HTTP/JSON — no
OpenTelemetry SDK dependency (it speaks the OTLP wire protocol directly, so the
package stays zero-dependency and version-drift-free).

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  plugins: [localExecutorPlugin(), localCachePlugin(), otel()],
})
```

`otel()` is **zero-config** via the standard OTel environment variables and
**declines safely** (exports nothing) when no endpoint is set — so it is safe
to declare in every environment:

| Variable                              | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | base collector URL (e.g. `http://localhost:4318`) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | full traces URL override                          |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | full metrics URL override                         |
| `OTEL_SERVICE_NAME`                   | service name (default `vx`)                       |
| `OTEL_EXPORTER_OTLP_HEADERS`          | `k=v,k=v` headers (e.g. auth)                     |

Options override env:

```ts
otel({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-monorepo',
  headers: { authorization: 'Bearer …' },
  metrics: true, // default
})
```

## What it exports

**A trace per run** (OTel CI/CD + VCS semantic conventions):

- a root `vx.run` span — `cicd.pipeline.run.id`, `vcs.ref.head.revision`,
  `vcs.ref.head.name`, CI provider, host/os/arch, vx version, `--tag k=v` →
  `vx.tag.<k>`;
- a child `vx.task` span per task — `cicd.pipeline.task.name`,
  `cicd.pipeline.task.run.result`, `vx.cache.source` (miss/local/remote),
  `vx.task.hash`, duration, CPU ms, peak RSS. A failed task sets span status
  `ERROR`.

**Metrics per run**: `vx.tasks.total`, `vx.tasks.failed`,
`vx.tasks.cache_hits{source=local|remote}`, and the `vx.run.duration_ms` gauge.

## Behavior note

This replaces core's previous hardcoded OTel emit, which fired automatically
whenever `OTEL_EXPORTER_OTLP_ENDPOINT` was set. OTel is now a **plugin**: the
env var alone no longer auto-exports — you must declare `otel()` in
`vx.workspace.ts`. Telemetry is observe-only and can never change, slow, or
fail a run (every export is buffered, time-bounded, and swallows errors).
