# Wire protocol — JSON-RPC 2.0 + OTel LogRecord payload

Status: **SHIPPED 2026-06-21** as `src/orchestrator/wire.ts` (~280
LOC). The single biggest leverage move from
`architecture-review-2026-06.md` §7 — one envelope across every vx
wire surface (WS, SSE, NDJSON, MCP, A2A, OTLP bridge). Every
downstream surface now reads off this contract.

## Implementation snapshot (2026-06-21)

| Item                                                                      | Status                                     | Where                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `Envelope` union (Request/Response/Error/Notification)                    | ✓ shipped                                  | `src/orchestrator/wire.ts`                             |
| Envelope builders + type guards                                           | ✓ shipped                                  | same                                                   |
| `ENVELOPE_ERRORS` code namespace (vx-specific in -32000..-32099)          | ✓ shipped                                  | same                                                   |
| `serverMessageToEnvelope` / `envelopeToServerMessage`                     | ✓ shipped                                  | same                                                   |
| `clientMessageToEnvelope` / `envelopeToClientMessage`                     | ✓ shipped                                  | same                                                   |
| `encodeForWS` / `encodeForSSE` / `encodeForNDJSON` / `decodeEnvelope`     | ✓ shipped                                  | same                                                   |
| `WIRE_PROTOCOL_VERSION` + `WIRE_CHANNELS` constants                       | ✓ shipped                                  | same                                                   |
| `vx serve` `/version` returns capability list                             | ✓ shipped                                  | `src/cli/serve.ts`                                     |
| `vx serve` `/events` (SSE), `/stream` (NDJSON)                            | ✓ shipped                                  | `src/cli/serve.ts`; `tests/serve-transports.test.ts`   |
| `vx serve` WS accepts BOTH legacy `t:'run'` and new `submit.run` envelope | ✓ shipped                                  | `src/cli/serve.ts`                                     |
| Tests                                                                     | ✓ 22 wire tests + 3 serve-transports tests | `tests/wire.test.ts`, `tests/serve-transports.test.ts` |

## 1. The choice in one sentence

**Every vx wire message is a JSON-RPC 2.0 envelope; every event
payload is an OpenTelemetry-LogRecord-shaped object.** That's the
whole spec.

## 2. The envelope

JSON-RPC 2.0 is a tiny, ubiquitous standard (a request has
`{ jsonrpc: "2.0", id, method, params }`, a response has
`{ jsonrpc: "2.0", id, result } | { jsonrpc: "2.0", id, error }`,
a notification has `{ jsonrpc: "2.0", method, params }`). It is what
MCP uses, what A2A uses, what birpc compiles to. By committing to it,
every external consumer that already knows JSON-RPC works with vx
out of the box.

```ts
type Envelope =
  | { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown } // request
  | { jsonrpc: '2.0'; id: number | string; result: unknown } // response
  | {
      jsonrpc: '2.0'
      id: number | string
      error: { code: number; message: string; data?: unknown }
    } // error
  | { jsonrpc: '2.0'; method: string; params?: unknown } // notification (no id)
```

## 3. The four channels (one wire, four logical surfaces)

| Channel     | Methods + notifications                                                                            | Direction       |
| ----------- | -------------------------------------------------------------------------------------------------- | --------------- |
| `vx:events` | notification `events.append(event)` — the running event stream                                     | server → client |
| `vx:state`  | request `state.snapshot()` → `RunState` + notification `state.patch(patches)` — derived view-model | both            |
| `vx:rpc`    | request/response `<method>(params)` — typed inspector queries                                      | client → server |
| `vx:submit` | request `submit.run(request)` + streamed `events.append` → response `RunResult`                    | client → server |

A connecting client picks the channels it cares about. A subscriber
only listens for `events.append`. An inspector only sends `vx:rpc`
requests. A driver sends `submit.run` and reads the streamed events
until the final result.

## 4. The event payload — OpenTelemetry LogRecord shape

OTel deprecated Span Events in favour of Logs API correlated with
spans. That model is exactly what our `RunEvent` is: a flat object
with a timestamp, a severity, a body, and structured attributes,
tied to a `(traceId, spanId)`. We adopt it verbatim:

```ts
type WireEvent = {
  // OTel LogRecord shape (canonical fields)
  timeUnixNano: string // wallclock, decimal string (JSON-safe for bigint)
  severityNumber: number // 1-24 per OTel spec (9 = INFO is our default)
  severityText?: string // optional human label ("info", "error", …)
  body: string // the human-readable rendering of the event
  attributes: Record<string, unknown> // structured event-specific fields
  traceId: string // run identifier (UUIDv7)
  spanId?: string // task identifier when scoped to a task
  // vx-specific (kept under a namespaced key to play nice with OTel)
  'vx.kind': RunEventKind // 'run:start' | 'task:start' | …
}

type RunEventKind =
  | 'run:start'
  | 'task:start'
  | 'task:stdout'
  | 'task:stderr'
  | 'task:complete'
  | 'run:status'
  | 'run:end'
```

This is **byte-identical** to the existing `WireEvent` in
`src/orchestrator/events.ts` after a one-time rename: rename the
existing fields to OTel names (`atMs → timeUnixNano`, etc.). The
fields we emit today all map cleanly:

| Today                          | OTel-shaped                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `WireEvent.kind`               | `'vx.kind'`                                                      |
| `WireEvent.atMs` (ms epoch)    | `timeUnixNano` (decimal string)                                  |
| `WireEvent.taskId`             | `spanId` + `attributes['vx.task.id']` (both, redundancy is fine) |
| `WireEvent.runId`              | `traceId`                                                        |
| Severity (failed/success/skip) | `severityNumber`: 17 (ERROR) for failed, 9 (INFO) default        |
| `WireEvent.chunk` (stdout)     | `body` for `task:stdout` events                                  |
| `WireEvent.outcome`            | nested into `attributes['vx.outcome']`                           |

The OTel CI/CD semantic conventions
(<https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/>) give
us canonical attribute names for every CI concept:
`cicd.pipeline.run.id`, `cicd.pipeline.task.name`,
`cicd.pipeline.task.run.result`, `cicd.worker.id`. We adopt these
where they map; we keep `vx.*` namespaced for our own additions.

### 4.1 Why this is worth the rename

- **OTel exporter is one file.** `@vx/otel-bridge` becomes a 50-LOC
  package: subscribe to the bus, map `WireEvent` directly to an OTel
  LogRecord (mostly already shaped), POST to OTLP.
- **MCP resources are free.** An MCP `vx://events` resource serves
  the same WireEvent payloads with zero translation.
- **A2A interop is one envelope.** A2A is JSON-RPC over
  HTTP+SSE — exactly our `vx:events` channel rendered over SSE.
- **Universal debugging.** Any Grafana / Honeycomb / Tempo /
  Datadog dashboard reads vx events without writing an integration.

## 5. The three transports (rendered consistently)

A single bus, one envelope, three encodings on the wire — driven by
client transport preference. The events emitted by the producer are
the same; the encoding into byte frames differs:

### 5.1 WebSocket (`/ws`)

Each WS message is one JSON-RPC envelope, UTF-8 JSON-encoded. The
client may send requests; the server responds in-band. Bidirectional.
The default for browser SPAs and `vx serve` clients.

```
client → { "jsonrpc":"2.0", "id":1, "method":"state.snapshot" }
server → { "jsonrpc":"2.0", "id":1, "result": {...RunState...} }
server → { "jsonrpc":"2.0", "method":"events.append", "params": {...WireEvent...} }
server → { "jsonrpc":"2.0", "method":"events.append", "params": {...} }
```

### 5.2 Server-Sent Events (`/events`)

Server → client only. Each event line is `data: <one JSON-RPC
notification envelope>\n\n`. The default for `curl`, simple scripts,
and any consumer that wants events without WS complexity.

```
data: { "jsonrpc":"2.0", "method":"events.append", "params": {...WireEvent...} }

data: { "jsonrpc":"2.0", "method":"events.append", "params": {...} }
```

### 5.3 NDJSON (`/stream`)

Server → client only. One JSON-RPC envelope per line, no SSE
framing. Convenient for `jq` pipelines and append-only log
aggregators.

```
{ "jsonrpc":"2.0", "method":"events.append", "params": {...WireEvent...} }
{ "jsonrpc":"2.0", "method":"events.append", "params": {...} }
```

The Hono migration (`docs/progress/implementation-log-2026-06.md`
Phase 10) wires all three off the same bus.

## 6. Versioning + capability handshake

The protocol version is `1.0`. `GET /version` returns:

```json
{
  "protocol": "1.0",
  "vx": "0.0.0",
  "channels": ["vx:events", "vx:state", "vx:rpc", "vx:submit"],
  "rpc": [
    "runTasks",
    "getRunState",
    "getCacheStats",
    "explainCacheKey",
    "whyDidThisRerun",
    "getRunHistory"
  ]
}
```

Clients negotiate by version-prefix matching. A v1.x client always
works with a v1.y server; a v2 server keeps v1 endpoints alive for
one minor release. The RPC method list is the discovery mechanism for
inspectors — a client probes `getCapabilities` (a built-in RPC) or
just reads `/version`.

## 7. Authentication

- **Local** (loopback): no auth, no token.
- **Remote** (`vx serve` exposed publicly, or vx cloud): bearer
  token in the WS handshake header `Authorization: Bearer <token>`
  for WS / SSE / NDJSON; for HTTP RPC, the same header on every
  request.
- **Cloud** (the vx-cloud Workers backend): same bearer, mapped to
  `(org_id, api_token)` per the vx-cloud auth model. The token check
  happens in the Worker layer; the underlying Durable Object never
  sees an unauthenticated request.

Tokens are scoped (org, role, expiry) per the vx-cloud spec; not
relevant to the wire shape but worth pinning here to keep the auth
story one paragraph rather than scattered.

## 8. Errors

JSON-RPC 2.0's error envelope:

```ts
{ "jsonrpc":"2.0", "id":1, "error": { "code": -32601, "message": "Method not found" } }
```

Codes follow the JSON-RPC spec for transport-level errors
(-32700 parse error, -32600 invalid request, -32601 method not
found, -32602 invalid params, -32603 internal error). Application
errors use codes in `-32000` to `-32099` (the JSON-RPC reserved
range for implementation-defined errors). vx-specific codes:

| Code   | Meaning                               |
| ------ | ------------------------------------- |
| -32000 | `UserError` (clean message, no stack) |
| -32001 | task hash unknown                     |
| -32002 | run not found                         |
| -32003 | unauthorized                          |
| -32004 | rate limited (cloud)                  |

Stack traces never cross the wire; the `error.data` carries
optional structured context (e.g. `{ taskId, command }`).

## 9. Backwards compatibility (the existing `protocol.ts`)

Today's `src/orchestrator/protocol.ts` defines a custom
`Server|ClientMessage` enum with `t` discriminator. The transition:

1. **Now**: this doc exists; `protocol.ts` continues as-is.
2. **Soon**: introduce a `toEnvelope(message)` /
   `fromEnvelope(envelope)` adapter; `vx serve` accepts BOTH formats
   on the same WS endpoint (parses one, falls back to the other).
   The internal dispatch stays on `t`; only the framing changes.
3. **Later**: deprecate `t`-discriminated messages; clients migrate.
4. **Eventually**: remove the legacy path.

This is the same "additive, never break the inner loop" pattern that
landed event-bus Phase 1a (bus shipped, terminal stayed byte-identical).

## 10. The fields we DON'T add to the envelope

A few attractive nuisances we deliberately skip:

- **Compression flag.** WS / SSE handle compression at the transport
  layer (Bun's `compress: true` for WS, `Content-Encoding: gzip` for
  HTTP). Not the protocol's concern.
- **Schema-version field per message.** Discovered via `/version`;
  not on every envelope.
- **Sequence numbers.** WS preserves order; SSE is sequential by
  contract; NDJSON is one-per-line. We don't need monotonic ids in
  the payload — that's what JSON-RPC `id` is for on request/response
  flows.
- **Timestamps in the envelope.** Timestamps live in the event
  payload (`timeUnixNano`), not the envelope. The envelope is
  transport metadata only.

## 11. Done state

The protocol is "done" when:

- `src/orchestrator/wire.ts` exists with `Envelope` + `WireEvent`
  valibot schemas.
- `vx serve` accepts both old `t`-discriminated and new envelope
  forms.
- The OTel CI/CD attributes are emitted on `task:start` /
  `task:complete` events.
- An `@vx/otel-bridge` subscriber can run against a real `vx run`
  and produce valid OTLP records.

This is Wave 2 from the review's revised plan; the rest of the arc
(MCP, distributed-ci, vx-cloud, etc.) all read off this contract.
