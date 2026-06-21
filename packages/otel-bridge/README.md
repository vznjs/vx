# @vzn/vx-otel-bridge

Thin one-direction adapter that subscribes to a vx event bus and exports
[OpenTelemetry LogRecords](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
over OTLP/HTTP. The vx core stays free of OTel runtime deps; this package
is the bridge.

## Why

Every vx wire event is already shaped to map cleanly to an OTel LogRecord
(see `docs/design/wire-protocol-2026-06.md` §4). The bridge applies the
[CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/)
so any OTel-aware backend (Grafana, Honeycomb, Tempo, Datadog, Jaeger,
Splunk) reads vx runs without writing an integration.

## Install

```sh
bun add @vzn/vx-otel-bridge
```

## Usage

```ts
import { createOtelBridge } from '@vzn/vx-otel-bridge'
import { createEventBus, run } from '@vzn/vx'

const bus = createEventBus()
const bridge = createOtelBridge({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  serviceName: 'vx',
})
const detach = bridge.attach(bus)

await run({ tasks: ['build'], cwd: process.cwd(), bus })

detach()
await bridge.cleanup()
```

Once the vx Plugin API ships you'll wire this in `vx.workspace.ts`:

```ts
import { defineWorkspace } from '@vzn/vx'
import { createOtelBridge } from '@vzn/vx-otel-bridge'

export default defineWorkspace({
  plugins: [createOtelBridge()],
})
```

## Environment variables

The bridge follows the standard OTel discovery rules:

| Variable                          | Effect                                                     |
| --------------------------------- | ---------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | OTLP collector base URL (default `http://localhost:4318`). |
| `OTEL_SERVICE_NAME`               | Resource attribute `service.name` (default `vx`).          |
| `OTEL_EXPORTER_OTLP_HEADERS`      | Comma-separated `key=value` auth headers.                  |
| `OTEL_RESOURCE_ATTRIBUTES`        | Extra resource attributes.                                 |

Explicit options on `createOtelBridge({ endpoint, serviceName, headers })`
override env vars.

## Pointing at a backend

### Grafana / Tempo

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Honeycomb

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_KEY"
```

Or wire via options:

```ts
createOtelBridge({
  endpoint: 'https://api.honeycomb.io',
  headers: { 'x-honeycomb-team': process.env.HONEYCOMB_KEY! },
})
```

## CI/CD semconv mapping

| WireEvent field                       | LogRecord attribute             |
| ------------------------------------- | ------------------------------- |
| `traceId` (vx run id)                 | `cicd.pipeline.run.id`          |
| `attributes['vx.task.id']`            | `cicd.pipeline.task.name`       |
| `attributes['vx.outcome.status']`     | `cicd.pipeline.task.run.result` |
| `attributes['vx.worker.id']`          | `cicd.worker.id`                |

Everything else stays under the `vx.*` namespace (`vx.task.project`,
`vx.outcome.duration_ms`, `vx.outcome.cpu_ms`, …).
