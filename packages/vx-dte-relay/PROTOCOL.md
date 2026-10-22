# vx-dte relay protocol, v1

A relay carries messages between one run's orchestrator and its agents.
CI runners take no inbound connection, so every participant dials out to
the relay and polls it. Any server that speaks this protocol can stand in
for `@vzn/vx-dte-relay`; `@vzn/vx-dte` knows only the relay's URL.

The relay never reads a message body. What the orchestrator and agents say
to each other is `@vzn/vx-dte`'s business, versioned on its own.

## Requests

Every request is HTTP with a JSON body or none, under
`<relay>/v1/runs/<run>/`, where `<run>` is the run id the plan printed
(`[A-Za-z0-9._-]{1,128}`). Every request carries
`Authorization: Bearer <CI OIDC token>`.

| Request                      | Body                                                  | Answer                                     |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `POST join`                  | `{ "role": "orchestrator" \| "agent", "info"?: any }` | `200 { "id", "heartbeatMs" }`              |
| `POST send`                  | `{ "id", "to", "body": any }`                         | `204`                                      |
| `GET poll?id=<id>&wait=<ms>` | none                                                  | `200 { "messages": [{ "from", "body" }] }` |
| `POST leave`                 | `{ "id" }`                                            | `204`                                      |

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

Every request naming an `id` counts as a heartbeat. A participant silent
for three `heartbeatMs` is lost, as if it had left. Polling with a `wait`
below `heartbeatMs` keeps a participant alive.

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
  lost. The run is then closed: every later request answers `410`.

An agent's messages carry `"from": "<its id>"`, the orchestrator's
`"from": "orchestrator"`.

## Errors

`400` a malformed request, `401` a missing or invalid token, `403` a token
of a repository the relay does not serve, `404` an unknown `id` or `to`, `409` a second
orchestrator, `410` a closed run, `413` a body over 1 MiB, `429` a queue
over 10 000 messages. An error answers `{ "error": "<reason>" }`.

## Tokens

The relay checks each token's signature against its issuer's published
keys (`<iss>/.well-known/openid-configuration`, then `jwks_uri`; RS256),
its `exp` and `nbf`, that `iss` is one the relay trusts, that `aud`
names the relay's audience, and that the token's repository is one the
relay serves (`repository` on GitHub Actions, `project_path` on GitLab,
matched without case; else `403`). A run is its id within its token's
issuer and run claims: the same id in a token of another repository is
another run, so a tenant cannot open a run id (a GitHub `run_id` is
guessable) before its owner does. The run claims name the repository:

| Issuer                                                         | Run claims      |
| -------------------------------------------------------------- | --------------- |
| GitLab (`https://gitlab.com`, or a self-managed host)          | `project_id`    |
| GitHub Actions (`https://token.actions.githubusercontent.com`) | `repository_id` |

So only jobs of the repository that started a run can join it. Not of its
pipeline: agents run in another one (a GitLab child pipeline, a GitHub
workflow the run dispatches). Which agents take part is the run's own
business: `@vzn/vx-dte` admits only an agent that completes a Noise
handshake with the run's key, or on GitHub one bound by its OIDC identity
(below).

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

| Who          | `info` / `body`                                       |
| ------------ | ----------------------------------------------------- |
| agent `join` | `info: { "noise": <message 1>, "token"? }`            |
| orchestrator | `{ "type": "hello", "noise": <message 2>, "token"? }` |
| orchestrator | `{ "type": "refused", "reason" }`, plain              |
| either, then | `{ "seal": ["<n>.<ciphertext>", …] }`                 |

Message 1's payload is the agent's info (JSON), encrypted under the psk.
After the handshake every body is Noise transport messages, base64, each
at most 65535 bytes and naming its nonce `n` (Noise §11.4, since a relay
may reorder); a nonce seen before is a replay and is dropped, one that
does not open loses its sender.
