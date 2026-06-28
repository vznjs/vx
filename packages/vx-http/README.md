# @vzn/vx-http

The manual-API telemetry exporter for [`@vzn/vx`](https://github.com/vznjs/vx).
POSTs the canonical `TelemetryRecord` / `RunSummaryRecord` contract to any HTTP
endpoint — the simplest way to get vx run/build data into your own system.

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { httpTelemetry } from '@vzn/vx-http'

export default defineWorkspace({
  plugins: [httpTelemetry({ url: 'https://my-collector.example.com/ingest' })],
})
```

Zero-config via env vars (`VX_TELEMETRY_URL`, `VX_TELEMETRY_TOKEN`); declines
safely when no URL is set.

## Modes

| Mode                | What it sends                                      | When                               |
| ------------------- | -------------------------------------------------- | ---------------------------------- |
| `summary` (default) | one `RunSummaryRecord` (the whole run) in one POST | at run end                         |
| `stream`            | batched `TelemetryRecord`s (per-task/live)         | every `batchSize`, then at run end |

```ts
httpTelemetry({
  url: 'https://collector/ingest',
  token: '…', // Bearer auth
  mode: 'summary', // or 'stream'
  format: 'ndjson', // or 'json'
  batchSize: 100, // stream mode
  includeLogs: false, // stream mode: include task.log chunks
  timeoutMs: 5000,
})
```

`summary` mode is the smallest contract — one request per run, ideal for a
run-history store. `stream` mode emits NDJSON (`application/x-ndjson`) or a JSON
array, for per-task or live consumers.

## Guarantees

Observe-only and never-fail: a sink holds no run handle, every POST is
time-bounded, errors are swallowed, and `flush` is idempotent — a down endpoint
can never slow or fail a run. This is the same contract `@vzn/vx-cloud`'s ingest
endpoint speaks.
