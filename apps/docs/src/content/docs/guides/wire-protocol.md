---
title: vx serve wire protocol — JSON-RPC 2.0
description: One envelope, three transports. Connect your own tooling to vx serve via WebSocket, Server-Sent Events, or NDJSON. JSON-RPC 2.0 compatible — every existing JSON-RPC client works.
---

`vx serve` exposes the run event stream + the submit-a-run API
over a single JSON-RPC 2.0 wire. Three transports off the same bus:

- **WebSocket** at `/` — bidirectional; submit runs, receive events.
- **Server-Sent Events** at `/events` — read-only; `curl -N` works.
- **NDJSON** at `/stream` — read-only; jq-friendly, one envelope
  per line.

Every external consumer that already speaks JSON-RPC works against
vx out of the box. That includes MCP clients, A2A agents, web
SPAs, shell scripts, custom dashboards, anything.

Full spec: `docs/design/wire-protocol-2026-06.md`. This guide is
practical.

## Discover the server

```sh
vx serve --port 5176             # in one terminal
curl http://localhost:5176/version
```

```json
{
  "protocol": "1.0",
  "vx": "0.0.0",
  "channels": ["vx:events", "vx:state", "vx:rpc", "vx:submit"],
  "rpc": [
    "getCacheStats",
    "getRunHistory",
    "explainCacheKey",
    "whyDidThisRerun"
  ]
}
```

Version-prefix matching: a v1.x client talks to a v1.y server. The
RPC method list is the inspector capability list.

## Tail events (the read-only path)

### SSE

```sh
curl -N http://localhost:5176/events
```

Each event arrives as `data: <json>\n\n`. Submit a run elsewhere:

```sh
vx run lint
```

Your `curl` window now prints every event of the run as a JSON-RPC
notification:

```
data: { "jsonrpc": "2.0", "method": "events.append", "params": { "kind": "run:start", … } }

data: { "jsonrpc": "2.0", "method": "events.append", "params": { "kind": "task:start", … } }
```

### NDJSON for jq

```sh
curl -N http://localhost:5176/stream | jq -r '.params.kind'
```

One envelope per line; `jq` reads them streamingly.

## Submit a run over WebSocket

Two ways — both work on the same WS endpoint.

### Legacy `t:'run'` frame

```ts
const ws = new WebSocket('ws://localhost:5176/')
ws.onopen = () => {
  ws.send(JSON.stringify({
    t: 'run',
    request: { cwd: '/path/to/workspace', tasks: ['lint'] },
  }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data) // { t: 'event' | 'result' | 'error', … }
}
```

### JSON-RPC 2.0 `submit.run` request

```ts
const ws = new WebSocket('ws://localhost:5176/')
ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'submit.run',
    params: { cwd: '/path/to/workspace', tasks: ['lint'] },
  }))
}
ws.onmessage = (ev) => {
  const env = JSON.parse(ev.data)
  if ('result' in env) console.log('done', env.result)
  else if ('error' in env) console.log('failed', env.error)
  else if (env.method === 'events.append') console.log('event', env.params)
}
```

The server accepts both formats on the same connection — parse
once, classify, dispatch. Use whichever your client lib makes
easier.

## Channels

| Channel | Methods | Direction |
| --- | --- | --- |
| `vx:events` | notification `events.append(event)` | server → client |
| `vx:state` | request `state.snapshot()` + notification `state.patch(patches)` | both (not yet shipped over WS — MCP-only) |
| `vx:rpc` | request `<method>(params)` — typed inspector queries | client → server (not yet shipped over WS — `vx mcp` stdio works) |
| `vx:submit` | request `submit.run(request)` + streamed `events.append` → response `RunResult` | client → server |

## Event shape

Each `events.append` notification carries a `WireEvent` whose body
is built from one of seven `vx.kind` values:

```ts
type WireEventKind =
  | 'run:start'      // run begins
  | 'task:start'     // a task begins executing
  | 'task:stdout'    // stdout chunk; body = the chunk
  | 'task:stderr'    // stderr chunk
  | 'task:complete'  // task ends; attributes carry the outcome
  | 'run:status'     // run-level status line
  | 'run:end'        // run finishes
```

In the wire-spec doc you'll see this referred to as
"OTel-LogRecord-shaped" — that's the planned canonical form. Today's
emitted shape uses the legacy `kind`/`atMs`/`taskId` fields plus
attributes. The OTel rename is a follow-up.

## Error envelopes

JSON-RPC 2.0 errors are returned with their standard codes. vx
also defines its own range:

| Code | Meaning |
| --- | --- |
| -32700 | parse error |
| -32600 | invalid request |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | internal error |
| -32000 | vx UserError (clean message, no stack) |
| -32001 | task hash unknown |
| -32002 | run not found |
| -32003 | unauthorized |
| -32004 | rate limited (cloud) |

## Auth

Localhost loopback: no auth. Remote (vx cloud): `Authorization:
Bearer <token>` header on every request and on the WS handshake.

## Example — phone notification when CI passes

Bash one-liner using SSE:

```sh
curl -N https://vx-cloud-xxx.workers.dev/events \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.params | select(.kind == "run:end")' \
  | while read; do curl -X POST https://api.pushover.net/1/messages.json \
      -d "token=$P_TOKEN" -d "user=$P_USER" -d "message=Build done"; done
```

Three lines and you have a phone push for every CI finish, OS-
independent.

## Example — TS subscriber

```ts
const ws = new WebSocket('ws://localhost:5176/')
ws.onmessage = (ev) => {
  const env = JSON.parse(ev.data)
  if ('method' in env && env.method === 'events.append') {
    const e = env.params
    if (e.kind === 'task:complete' && e.outcome?.status === 'failed') {
      console.log(`🚨 ${e.taskId} failed`)
    }
  }
}
```

Equivalent in Python, Go, Rust — any language with a JSON-RPC
client. The wire is the SDK.

## See also

- `docs/design/wire-protocol-2026-06.md` — full spec
- `docs/design/extension-protocol-2026-06.md` — subscribers,
  inspectors, drivers, plugins
- [`vx mcp` guide](/vx/guides/mcp/) — agent-side
- [`vx serve` CLI](/vx/cli/#vx-serve--execution--event-stream-service)
