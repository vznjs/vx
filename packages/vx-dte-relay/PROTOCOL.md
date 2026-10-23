# vx-dte relay protocol, v1

A relay carries messages between one run's orchestrator and its workers.
CI runners take no inbound connection, so every participant dials out to
the relay: `join` over HTTP, then a websocket that carries the rest.
Any server that speaks this protocol can stand in
for `@vzn/vx-dte-relay`; `@vzn/vx-dte` knows only the relay's URL.

The relay never reads a message body. What the orchestrator and workers say
to each other is `@vzn/vx-dte`'s business, versioned on its own.

## Requests

Two requests are HTTP, under `<relay>/v1/runs/<run>/`, where `<run>` is
the run id, a random (v4) UUID, so no one can guess it; any other answers
`400`. Each carries `Authorization: Bearer <CI OIDC token>`.

| Request               | Body                                                           | Answer                                  |
| --------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `POST join`           | `{ "role": "orchestrator" \| "worker", "info"?: any, "key"? }` | `200 { "id", "heartbeatMs", "socket" }` |
| `GET socket?id=<id>`  | none, a websocket upgrade                                      | `101`                                   |
| `GET socket?join=<j>` | none, a websocket upgrade; `<j>` is `join`'s body, as JSON     | `101`                                   |

- `join` makes a participant and returns its `id`, a secret the relay
  picked: whoever holds it, with a token of this run, acts as it. A run
  has one orchestrator; a second `orchestrator` join answers `409`. The
  orchestrator's join starts the run, and a run is kept only while it is
  live: a worker's join of any other answers `410`, and the worker leaves.
  `"socket": true` says the relay
  speaks this version.
- `socket` opens the participant's websocket (§ Sockets). With `join`
  in place of `id` it joins too, as `join` would, and the socket's first
  frame is `{ "joined": { "id", "heartbeatMs" } }`: one request a
  participant, not two, on a host that bills each. A socket dialed again
  names its `id`. An orchestrator signs it like any `socket`, the body
  in its query.

## The orchestrator's key

A run id is a channel: workers join it before or after the orchestrator
does, and the orchestrator claims it. Its `join` names `key`, a P-256
public key (raw, base64url), and the relay keeps it for the run; a join
without one answers `400`. Its join and each `socket` upgrade carry `vx-proof: <ms>.<nonce>.<signature>`: an
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

`socket` is the participant's websocket (`426` without the upgrade).
Frames are text:

- the relay pushes `{ "messages": [{ "from", "body" }] }` as messages
  arrive, starting with any queued before the socket opened;
- the participant sends `{ "n", "sends": [{ "to", "body" }] }`, answered
  `{ "n" }` when all were taken, else `{ "n", "results" }` with `null` or
  `{ "status", "error" }` for each. The orchestrator sends to any worker;
  a worker sends only to `"orchestrator"`; an unknown or gone `to` is
  `404`;
- `{ "n", "leave": true }` removes the participant, and its answer is the
  socket's close. The orchestrator leaving closes the run;
- `{ "n", "remove": "<worker>" }`, by the orchestrator only (`403`
  otherwise), takes the worker off the run: one it did not admit
  (§ Bodies). The worker's socket is pushed what queued for it, its
  `refused` with the reason, and closed. The orchestrator is not told it
  was lost;
- a frame that fails is answered `{ "n", "status", "error" }`, any other
  frame `400`. A frame is held to 1 MiB whole; one over it is answered `413` by its `n` when the
  frame starts `{"n":`. vx-dte's client keeps a frame of several sends
  under 512 KiB;
- the participant sends a frame or `ping` at least each `heartbeatMs`;
  the relay answers `pong`. A host may answer pings without the relay
  (Cloudflare's auto-response), so pongs are no word from the relay:
  vx-dte's client, having heard no push or answer for a heartbeat, sends
  `{ "n", "sends": [] }`, which the relay itself answers, and treats a
  socket that leaves a frame or an upgrade unanswered for two heartbeats
  (10 s at most) as closed: a network that stops carrying a socket sends
  no close;
- the socket a frame comes down is its participant's from then on, and
  what queued for it is pushed down it: a host that let the socket go
  while answering its pings left the participant deaf.

A socket's close does not lose its participant: it opens another, and
the relay pushes what queued meanwhile. vx-dte's client dials again
after a backoff with full jitter (up to 250 ms, doubling per failed dial
to half a heartbeat), and gives the participant up after 3 failed
dials or 10 s without a socket, whichever comes first. The relay closes with code
`4404` the socket of a participant that left or was lost, after pushing
what queued for it (a removed worker's `refused`), and lets in a `socket`
request of an `id` or run it does not know only to close it so: a failed
upgrade tells a client nothing it can read. It closes a socket a push
failed on without a code: left open, its pings answered, it would carry
nothing again.

Every frame and ping counts as a heartbeat. A participant silent two
`heartbeatMs` (10 s on the default) is lost, as if it had left, on a
socket or not. The orchestrator's socket closing closes the run at once.
vx-dte's client asks again through a `5xx`, a dropped connection or a
`429`, 3 times at most and within 10 s of the first try.

## Leases (planned, above the relay)

Leases are `@vzn/vx-dte`'s messages, so the relay stays body-blind. The
orchestrator leases each task to one worker with an expiry, and every
frame that worker sends renews its leases. A lease that expires sends
its task back to ready. The orchestrator accepts a result only from the
task's current lease holder and drops any late one. The design is in
`packages/vx/docs/design/dte-2026-10.md`.

## Messages from the relay

The relay itself sends with `"from": "relay"`:

- to the orchestrator, `{ "type": "joined", "id", "info" }` for each worker;
- to the orchestrator, `{ "type": "lost", "id" }` when a worker leaves or
  is lost;
- to every worker, `{ "type": "closed" }` when the orchestrator leaves or is
  lost, or its socket closes. The relay then keeps nothing of the run: a
  worker on a socket is told and let go at once, one with no socket gets
  `4404` when it opens one, and a `join` answers `410`.

A worker's messages carry `"from": "<its id>"`, the orchestrator's
`"from": "orchestrator"`.

## Errors

`400` a malformed request, `401` a missing or invalid token, `403` a token
of a repository the relay does not serve, `403` a request as the orchestrator from another CI job (§ Tokens) or not signed by its key (§ The orchestrator's key), `404` an unknown `id` or `to`, `409` a second
orchestrator, `410` a closed run, `413` a body over 1 MiB, `426` a
`socket` request that is not an upgrade, `429` a send to a queue
over 10 000 messages or 64 MiB (the relay's own `joined`, `lost` and
`closed` still queue), or a participant past its rate: a burst
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
leaked to a worker or a log acts from nowhere else. Its workers run in
other jobs and talk only to `"orchestrator"`, which is always that one. Not of its
pipeline: workers run in another one (a GitLab child pipeline, a GitHub
workflow the run dispatches). Which workers take part is the run's own
business: `@vzn/vx-dte` admits only a worker that completes a Noise
handshake with the run's key, or on GitHub one bound by its OIDC identity
(below).

## What the relay knows

Only what routing needs, and no longer:

- A run is a SHA-256 of its id and its tokens' issuer and run claims: no
  store or object name says whose run it is. A token is checked, never kept.
- A worker's `info` is held until the orchestrator is told it joined; the
  orchestrator's is dropped.
- A message waits in memory, never in storage, until it is delivered. A
  relay restart loses a participant whose queue was not empty, as if it
  went silent.
- A closed run is gone at once; while open, each participant's
  role and when it was last heard from are kept, so a restart still
  loses the silent.
- It logs nothing. It still sees each message's size, time and recipient.

## Bodies, end to end

What `@vzn/vx-dte` puts in `info` and `body` is opaque to the relay. For
anyone writing a worker or orchestrator of their own: each worker and the
orchestrator run a [Noise](https://noiseprotocol.org/noise.html) handshake
through the relay, prologue `vx-dte\0<run>`, the worker the initiator.

- With the run's key (`VX_DTE_SECRET`, or the one `vx dte plan` or an
  adapter made): `Noise_NNpsk0_25519_AESGCM_SHA256`, the psk the key's
  SHA-256. A side with another key cannot complete.
- Keyless on GitHub Actions: `Noise_NN_25519_AESGCM_SHA256`. The worker's
  `join` carries an OIDC token whose audience is
  `vx-dte:<base64url SHA-256 of "join\0<run>\0<message 1>">`; the
  orchestrator's `hello` one for `"hello\0<run>\0<handshake hash>"`. Each
  side checks the other's as a token of the same `repository_id`.

| Who           | `info` / `body`                                         |
| ------------- | ------------------------------------------------------- |
| worker `join` | `info: { "noise": <message 1>, "token"? }`              |
| orchestrator  | `{ "type": "hello", "noise": <message 2>, "token"? }`   |
| orchestrator  | `{ "type": "refused", "reason" }`, plain, then `remove` |
| either, then  | `{ "seal": ["<n>.<ciphertext>", …] }`                   |

The orchestrator checks each worker the moment the relay says it joined,
before or after its own join, and `remove`s one whose handshake fails.
Message 1's payload is the worker's info (JSON), encrypted under the psk.
After the handshake every body is Noise transport messages, base64, each
at most 65535 bytes and naming its nonce `n` (Noise §11.4, since a relay
may reorder); each is sealed with associated data `<first n>.<parts>`
of its body, so no part opens in another body. A body whose first nonce
was seen before is a replay and is dropped, one that does not open loses
its sender. The plaintext is JSON padded with trailing
spaces to its size class, a power of two from 256 bytes, then whole
transport messages, so the relay learns no size within a class (after
Tailscale's DERP).
