# vx-dte relay protocol, v1

A relay carries messages between one run's orchestrator and its agents.
CI runners take no inbound connection, so every participant dials out to
the relay: over a websocket where the relay offers one, else by polling. Any server that speaks this protocol can stand in
for `@vzn/vx-dte-relay`; `@vzn/vx-dte` knows only the relay's URL.

The relay never reads a message body. What the orchestrator and agents say
to each other is `@vzn/vx-dte`'s business, versioned on its own.

## Requests

Every request is HTTP with a JSON body or none, under
`<relay>/v1/runs/<run>/`, where `<run>` is the run id, a random (v4)
UUID, so no one can guess it; any other answers `400`. Every request carries
`Authorization: Bearer <CI OIDC token>`.

| Request                      | Body                                                          | Answer                                     |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `POST join`                  | `{ "role": "orchestrator" \| "agent", "info"?: any, "key"? }` | `200 { "id", "heartbeatMs", "socket"? }`   |
| `POST send`                  | `{ "id", "to", "body": any }`                                 | `204`                                      |
| `GET poll?id=<id>&wait=<ms>` | none                                                          | `200 { "messages": [{ "from", "body" }] }` |
| `POST leave`                 | `{ "id" }`                                                    | `204`                                      |
| `POST remove`                | `{ "id", "agent" }`                                           | `204`                                      |
| `GET socket?id=<id>`         | none, a websocket upgrade                                     | `101`                                      |

- `join` makes a participant and returns its `id`, a secret the relay
  picked: whoever holds it, with a token of this run, acts as it. A run
  has one orchestrator; a second `orchestrator` join answers `409`. Agents
  may join before the orchestrator does.
- `send` queues `body` for `to`. The orchestrator sends to any agent; an
  agent sends only to `"orchestrator"`. An unknown or gone `to` answers
  `404`.
- `poll` returns the messages queued for `id`, oldest first, and empties
  the queue. With none queued it holds the request until one arrives or
  `wait` ms pass (at most 25 000), then answers with what it has.
- `leave` removes the participant. The orchestrator leaving closes the run.
- `remove`, by the orchestrator only (`403` otherwise), takes `agent` off
  the run: one it did not admit (§ Bodies). The agent's next poll gets
  what was queued for it, its `refused` with the reason; after that its
  `id` answers `404`. The orchestrator is not told it was lost.

## The orchestrator's key

A run id is a channel: agents join it before or after the orchestrator
does, and the orchestrator claims it. Its `join` names `key`, a P-256
public key (raw, base64url), and the relay keeps it for the run; a join
without one answers `400`. Every request as the orchestrator after that,
its join included, carries `vx-proof: <ms>.<nonce>.<signature>`: an
ECDSA SHA-256 signature by that key of

```
vx-dte-proof\0<method>\0<path and query>\0<ms>\0<nonce>\0<body>
```

`<ms>` the time it was made, within two minutes of the relay's clock,
and `<nonce>` 16 to 64 base64url characters the relay takes once. Any
other answers `403`. So only the side holding the private key, which
never leaves it, acts as the orchestrator, and the relay passes no
message to or from any other: a second orchestrator `join` answers
`409`, and a closed run never takes one. A `socket` frame carries no
proof: its upgrade did.

## Sockets

A relay whose `join` answers `"socket": true` takes `socket`, a websocket
for the participant (`426` without the upgrade). Frames are text:

- the relay pushes `{ "messages": [{ "from", "body" }] }` as messages
  arrive, starting with any queued before the socket opened;
- the participant sends `{ "n", "to", "body" }`, as `send`, and the relay
  answers `{ "n" }`, or `{ "n", "status", "error" }` with the status
  `send` would answer;
- to a relay whose `join` also answered `"frames": 2`, the participant may
  send several at once, `{ "n", "sends": [{ "to", "body" }] }`, answered
  `{ "n" }` when all were taken, else `{ "n", "results" }` with `null` or
  `{ "status", "error" }` for each; `{ "n", "remove": "<agent>" }`, as
  `remove`; and `{ "n", "leave": true }`, as `leave`, whose answer is the
  socket's close. With such a socket open, `join` and its upgrade are the
  only requests a participant makes. A frame is held to `send`'s 1 MiB
  body limit whole; one over it is answered `413` by its `n` when the
  frame starts `{"n":`. vx-dte's client keeps a frame of several sends
  under 512 KiB;
- the participant sends `ping` at least each `heartbeatMs`; the relay
  answers `pong`. vx-dte's client pings each half heartbeat and treats a
  socket it heard nothing on for a heartbeat and a half as closed: a
  network that stops carrying a socket sends no close. A host may answer
  pings without the relay (Cloudflare's auto-response), so the client also
  treats a socket that leaves a frame unanswered for two heartbeats as
  closed, and sends or leaves over HTTP. An HTTP request it gives three
  heartbeats.

A socket's close does not lose its participant: it polls again, or opens
another. vx-dte's client does both: it polls over HTTP and dials a new
socket after a backoff with full jitter (up to 250 ms, doubling per failed
dial to 30 s). The relay closes the socket of a participant that left or was
lost, so its next request learns why.

Every request naming an `id` counts as a heartbeat. A participant silent
for three `heartbeatMs` is lost, as if it had left; one with an open
socket, for twelve, so a host that bills its wake-ups sleeps between
them. Polling with a `wait` below `heartbeatMs`, or a socket's `ping`,
keeps a participant alive.
vx-dte's client asks again through a `5xx` or a dropped connection (a
host restarting the relay) until faults have lasted three `heartbeatMs`,
or 15 s for `join`, before it knows a heartbeat.

## Leases (planned, above the relay)

Leases are `@vzn/vx-dte`'s messages, so the relay stays body-blind. The
orchestrator leases each task to one agent with an expiry, and every
request that agent makes renews its leases. A lease that expires sends
its task back to ready. The orchestrator accepts a result only from the
task's current lease holder and drops any late one. The design is in
`packages/vx/docs/design/dte-2026-10.md`.

## Messages from the relay

The relay itself sends with `"from": "relay"`:

- to the orchestrator, `{ "type": "joined", "id", "info" }` for each agent,
  including agents that joined before it;
- to the orchestrator, `{ "type": "lost", "id" }` when an agent leaves or
  is lost;
- to every agent, `{ "type": "closed" }` when the orchestrator leaves or is
  lost. The run is then closed: an agent on a socket is told and let go
  at once, one over HTTP reads `410` for a minute, and then the relay
  keeps nothing of the run. A run no orchestrator joined in ten minutes
  closes the same way: agents start after their orchestrator joins, so
  one alone is late for a run that ended.

An agent's messages carry `"from": "<its id>"`, the orchestrator's
`"from": "orchestrator"`.

## Errors

`400` a malformed request, `401` a missing or invalid token, `403` a token
of a repository the relay does not serve, `403` a request as the orchestrator from another CI job (§ Tokens) or not signed by its key (§ The orchestrator's key), `404` an unknown `id` or `to`, `409` a second
orchestrator, `410` a closed run, `413` a body over 1 MiB, `426` a
`socket` request that is not an upgrade, `429` a queue
over 10 000 messages or 64 MiB, or a participant past its rate: a burst
of 1000 requests and socket frames, then 100 a second, after Tailscale's
DERP. A rate's `429` says `"retryAfterMs"`, when the next one is taken;
`@vzn/vx-dte` waits that long and asks again. On Workers, `503` is a
run's Durable Object the host refused (a plan's daily limit), its
reason in the error. An error answers `{ "error": "<reason>" }`.

## Tokens

The relay checks each token's signature against its issuer's published
keys (`<iss>/.well-known/openid-configuration`, then `jwks_uri`; RS256),
its `exp` and `nbf`, that `iss` is one the relay trusts, that `aud`
names the relay's audience, and that the token's repository and workflow
are an entry the relay allows for its issuer (`repository` on GitHub
Actions, `project_path` on GitLab; `job_workflow_ref` on GitHub, a file of
`.github/workflows/`, `ci_config_ref_uri` on GitLab, any ref; matched
without case; else `403`). A run is its id within its token's
issuer and run claims: the same id in a token of another repository is
another run, so a tenant cannot open a run id before its owner does,
even one it learned. The run claims name the repository:

| Issuer                                                         | Run claims      |
| -------------------------------------------------------------- | --------------- |
| GitLab (`https://gitlab.com`, or a self-managed host)          | `project_id`    |
| GitHub Actions (`https://token.actions.githubusercontent.com`) | `repository_id` |

So only jobs of the repository that started a run can join it, and only
of a workflow the relay allows for that repository.

The orchestrator is pinned to the CI job it joined from: GitHub's
`check_run_id` (on a host whose tokens lack it, `run_id` and
`run_attempt`, which the run's other jobs share), GitLab's `job_id`. A request as the
orchestrator with a token of another job answers `403`, so its `id`
leaked to an agent or a log acts from nowhere else. Its agents run in
other jobs and talk only to `"orchestrator"`, which is always that one. Not of its
pipeline: agents run in another one (a GitLab child pipeline, a GitHub
workflow the run dispatches). Which agents take part is the run's own
business: `@vzn/vx-dte` admits only an agent that completes a Noise
handshake with the run's key, or on GitHub one bound by its OIDC identity
(below).

## What the relay knows

Only what routing needs, and no longer:

- A run is a SHA-256 of its id and its tokens' issuer and run claims: no
  store or object name says whose run it is. A token is checked, never kept.
- An agent's `info` is held until the orchestrator is told it joined; the
  orchestrator's is dropped.
- A message waits in memory, never in storage, until it is delivered. A
  relay restart loses a participant whose queue was not empty, as if it
  went silent.
- A closed run is gone within a minute; while open, each participant's
  role and when it was last heard from are kept, so a restart still
  loses the silent.
- It logs nothing. It still sees each message's size, time and recipient.

## Bodies, end to end

What `@vzn/vx-dte` puts in `info` and `body` is opaque to the relay. For
anyone writing an agent or orchestrator of their own: each agent and the
orchestrator run a [Noise](https://noiseprotocol.org/noise.html) handshake
through the relay, prologue `vx-dte\0<run>`, the agent the initiator.

- With the run's key (`VX_DTE_SECRET`, or the one `vx dte plan` or an
  adapter made): `Noise_NNpsk0_25519_AESGCM_SHA256`, the psk the key's
  SHA-256. A side with another key cannot complete.
- Keyless on GitHub Actions: `Noise_NN_25519_AESGCM_SHA256`. The agent's
  `join` carries an OIDC token whose audience is
  `vx-dte:<base64url SHA-256 of "join\0<run>\0<message 1>">`; the
  orchestrator's `hello` one for `"hello\0<run>\0<handshake hash>"`. Each
  side checks the other's as a token of the same `repository_id`.

| Who          | `info` / `body`                                         |
| ------------ | ------------------------------------------------------- |
| agent `join` | `info: { "noise": <message 1>, "token"? }`              |
| orchestrator | `{ "type": "hello", "noise": <message 2>, "token"? }`   |
| orchestrator | `{ "type": "refused", "reason" }`, plain, then `remove` |
| either, then | `{ "seal": ["<n>.<ciphertext>", …] }`                   |

The orchestrator checks each agent the moment the relay says it joined,
before or after its own join, and `remove`s one whose handshake fails.
Message 1's payload is the agent's info (JSON), encrypted under the psk.
After the handshake every body is Noise transport messages, base64, each
at most 65535 bytes and naming its nonce `n` (Noise §11.4, since a relay
may reorder); a nonce seen before is a replay and is dropped, one that
does not open loses its sender. The plaintext is JSON padded with trailing
spaces to its size class, a power of two from 256 bytes, then whole
transport messages, so the relay learns no size within a class (after
Tailscale's DERP).
