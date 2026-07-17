---
title: vx-cloud wire protocol — JSON-RPC 2.0
description: One envelope, two read transports. Tail the vx-cloud platform's run event stream over Server-Sent Events or NDJSON. JSON-RPC 2.0 compatible — every existing JSON-RPC client works.
---

The [`vx-cloud` platform](/vx/cloud/self-hosting/) broadcasts a live run
event stream over JSON-RPC 2.0. Two read transports off the same bus:

- **Server-Sent Events** at `/events` (also `/v1/events`) — `curl -N` works.
- **NDJSON** at `/stream` — jq-friendly, one envelope per line.

Both carry the events of every **distributed** run (`dist:submit`) the
platform is coordinating, as JSON-RPC notifications. Any consumer that
already speaks JSON-RPC — a dashboard, a shell script, a bot — can tail
them.

Full spec: `docs/design/wire-protocol-2026-06.md`. This guide is practical.

This page covers the **machine wire** — the stream envelopes and the
cache artifact wire. The full HTTP surface (auth, admin, analytics
reads, ingest writes — every route with parameters and clamps) is
enumerated in the [HTTP API reference](/vx/cloud/api/). The ingest
writes (`/v1/ingest`, `/v1/ingest/task`, `/v1/ingest/logs`) and the
catalog push (`/v1/catalog`) are wire-versioned — a version-skewed
client is answered 400 naming both versions.

## Discover the server

`/v1/meta` is the pre-auth identity + capability endpoint:

```sh
curl https://vx.example.com/v1/meta
```

```json
{
  "v": 1,
  "name": "vx.example.com",
  "vx": "0.0.0",
  "auth": "account",
  "artifacts": true,
  "cacheWire": 2,
  "trustTiers": true
}
```

It carries capability flags only — never tenant data — so it's safe before
you authenticate. `cacheWire: 2` means the server hosts the batch existence
probe below; a `1` server has only the per-hash cache wire (clients fall back
to per-hash `HEAD`s automatically).

## Cache wire

The shared cache is the `/v1/cache/*` surface, behind an API token (machine
principals only — a session cookie is refused). It is tenant- and
trust-scoped: which artifacts a request can see is derived from the token,
never from the request.

| Method + path              | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `HEAD /v1/cache/:hash`     | Existence probe for one artifact — `200` present, `404` absent.             |
| `GET /v1/cache/:hash`      | Fetch an artifact — `307` to a pre-signed bucket URL (offloaded storage).   |
| `PUT /v1/cache/:hash`      | Upload an artifact (`.tar.zst`); re-PUT of an existing hash is `409`.       |
| `POST /v1/cache/batch`     | **Batch existence probe** — one round-trip for many hashes (`cacheWire ≥ 2`). |

`POST /v1/cache/batch` takes `{ "hashes": string[] }` (up to 1024 per
request) and returns `{ "present": string[] }` — the subset stored in the
token's read scopes. It collapses N per-hash `HEAD`s into a single request, so
a fresh CI runner priming a 1000-task graph asks once instead of a thousand
times. The vx client uses it automatically to prefetch only the cache hits.

```sh
curl -X POST https://vx.example.com/v1/cache/batch \
  -H "authorization: Bearer $VX_CLOUD_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"hashes":["a1b2c3d4e5f60718","0000000000000000"]}'
# → {"present":["a1b2c3d4e5f60718"]}
```

## Auth

Every surface past `/health` and `/v1/meta` requires authentication. For a
programmatic consumer that means an API token (`vxc_`, minted under
**Admin → Tokens**) as `Authorization: Bearer <token>`. Browser transports
that can't set headers — `EventSource`, and the WebSocket upgrade — pass
`?token=<token>` in the query string instead. Every read is tenant-clamped
to the token's org (and, if the token is workspace-scoped, its workspace).

## Tail events (the read-only path)

### SSE

```sh
curl -N https://vx.example.com/events -H "Authorization: Bearer $TOKEN"
```

Each event arrives as `data: <json>\n\n`. While a distributed run is
executing, your window prints every event as a JSON-RPC notification:

```
data: { "jsonrpc": "2.0", "method": "events.append", "params": { "kind": "run:start", … } }

data: { "jsonrpc": "2.0", "method": "events.append", "params": { "kind": "task:start", … } }
```

### NDJSON for jq

```sh
curl -N https://vx.example.com/stream -H "Authorization: Bearer $TOKEN" \
  | jq -r '.params.kind'
```

One envelope per line; `jq` reads them streamingly.

## Event shape

Each `events.append` notification carries a `WireEvent` whose body is built
from one of seven `vx.kind` values:

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

## Error envelopes

JSON-RPC 2.0 errors are returned with their standard codes. vx also defines
its own range:

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
| -32004 | rate limited |

## Submitting runs

There is no "submit a run over the wire" API: run delegation was removed
when vx-cloud became a self-hosted platform — the platform has no workspace
checkout to execute against. To move work across machines, use
[distributed execution](/vx/cloud/distributed-ci/) (`VX_CLOUD_DISTRIBUTE`
+ `vx-cloud agent`), whose events show up on the streams above.

## Example — phone notification when CI passes

Bash one-liner using SSE:

```sh
curl -N https://vx.example.com/events \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.params | select(.kind == "run:end")' \
  | while read; do curl -X POST https://api.pushover.net/1/messages.json \
      -d "token=$P_TOKEN" -d "user=$P_USER" -d "message=Build done"; done
```

## Example — TS subscriber

```ts
const es = new EventSource('https://vx.example.com/events?token=' + TOKEN)
es.onmessage = (ev) => {
  const env = JSON.parse(ev.data)
  if (env.method === 'events.append') {
    const e = env.params
    if (e.kind === 'task:complete' && e.outcome?.status === 'failed') {
      console.log(`🚨 ${e.taskId} failed`)
    }
  }
}
```

Equivalent in Python, Go, Rust — any language with an SSE / JSON client.
The wire is the SDK.

## See also

- `docs/design/wire-protocol-2026-06.md` — full spec
- [`vx mcp` guide](/vx/cloud/mcp/) — the agent-side control plane
- [Self-host vx-cloud](/vx/cloud/self-hosting/) — deploy the platform
