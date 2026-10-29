# Switchboard protocol, v1

Switchboard connects one **host** to any number of **peers** through a
relay, when none of them takes an inbound connection (CI runners, laptops
behind NAT). Each participant dials out: one websocket, which joins as it
opens and carries the rest. The shape is a star: the host talks to every
peer, a peer talks only to the host, and the relay passes each message on
without reading it. What host and peers say to each other is their own
protocol, versioned on its own.

`@vzn/vx-dte-server` is one relay that speaks it (on Bun and on Cloudflare
Workers); any server that does can stand in for it.

## Versions

A client names the versions it speaks in the websocket's subprotocol
header, on the request that joins, so negotiation costs no round trip:

```
Sec-WebSocket-Protocol: switchboard.v2, switchboard.v1
```

The relay answers with the highest version both speak. If none is, it
answers with the first one offered (a client offered nothing it can read
otherwise) and closes the socket `4406`, reason `supported:
switchboard.v<lowest>-v<highest>`. A request offering none is refused the
same way. This document is `switchboard.v1`.

The path names the API version apart from the protocol's: every route is
under `/v1/`. A change to the routes ships under `/v2/`, beside `/v1/` for
as long as the relay keeps it, while the messages keep their subprotocol.

## Sessions

One request is HTTP, a websocket upgrade of `GET
<relay>/v1/sessions/<session>/socket`. `<session>` is the session id, a random
(v4) UUID, so no one can guess it; another answers `400`, another path
`404`, another method `405` (`Allow: GET`), a request that is no upgrade `426`. It carries
`Authorization: Bearer <token>` (§ Tokens).

| Query       | Does                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| `?join=<j>` | joins: `<j>` is `{ "role": "host" \| "peer", "info"?: any, "key"?: string }` |
| `?id=<id>`  | a participant's socket dialed again (§ Sockets)                              |

- A join's socket says first `{ "joined": { "id", "heartbeatMs" } }`. The
  `id` is a secret the relay picked: whoever holds it, with a token of this
  session, acts as that participant.
- The host's join opens the session; a session has one host, and a second
  host's join is refused `409`. A peer's join of a session with no host is
  refused `410`.
- A session lives while its host does. The host's `leave` is its final
  call: it closes the session at once, and the relay keeps nothing of it.
  A host whose socket dropped without it has the grace (§ Liveness) to
  dial again; the session waits for it. When the grace passes, the relay
  forgets the session and closes each peer's socket with no code: the
  host may still join it again, and a peer's redial, closed `4404`, joins
  again too.

## The host's key

The host's join names `key`, a P-256 public key (raw, base64url), which
the relay keeps for the session; one without it is refused `400`. Each of
the host's socket requests, its join too, carries `relay-proof: <ms>.<nonce>.<signature>`, an
ECDSA SHA-256 signature by that key of

```
switchboard-proof\0GET\0<path and query>\0<ms>\0<nonce>\0
```

`<ms>` is when it was made, within two minutes of the relay's clock, and
`<nonce>` 16 to 64 base64url characters the relay takes once; else `403`.
So only the side holding the private key acts as the host, and a leaked
host `id` acts as it nowhere. A frame carries no proof: its socket's
upgrade did.

## Frames

Frames are JSON text, each at most 1 MiB of UTF-8 (bytes, not characters).

The relay pushes:

- `{ "messages": [{ "from", "body" }] }` as messages arrive. `from` is
  `"host"`, a peer's `id`, or `"relay"` (§ Notices);
- `{ "close": <code>, "error"? }` just before it closes the socket, `0`
  for no code. A client acts on this frame: a host may never end TCP after
  its close.

A participant sends:

| Frame                                  | Does                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `{ "n", "sends": [{ "to", "body" }] }` | passes each `body` to `to`                                 |
| `{ "n", "leave": true }`               | removes the participant; its answer is the socket's close  |
| `{ "n", "remove": "<peer id>" }`       | the host only (`403` else): takes the peer off the session |

- The host sends to any peer `id`; a peer sends only to `"host"`. An
  unknown or gone `to` is `404`.
- A frame with a number `n` is answered `{ "n" }` when all went, else
  `{ "n", "results" }` with `null` or `{ "status", "error" }` for each
  send. A frame of sends with no `n` is answered only if a send in it
  fails, `n` then `null`.
- A frame that fails is answered `{ "n", "status", "error" }`; one that is
  no JSON object, or none of the above, `400`; one over 1 MiB `413`,
  answered by its `n` when the frame starts `{"n":`.
- A removed peer's socket is closed `4404` after what waited for it; the
  host is not told it left.

## Delivery

The relay holds no participant's message. One it cannot push now (no
socket, or a push that failed) is dropped. Delivery is the clients': a
sender numbers each send, the receiver acknowledges it end to end, and
the sender sends again what is not acknowledged, at once on a new socket.
How they number and acknowledge is inside `body`, their own protocol;
`@vzn/vx-dte` puts `{ "n" }` and `{ "acked" }` beside its payload.

Only the relay's notices wait, in memory, for the participant's next
socket.

## Notices

The relay itself sends, `"from": "relay"`:

- to the host, `{ "type": "joined", "id", "info" }` for each peer, its
  `info` as its join said, then forgotten;
- to the host, `{ "type": "left", "id" }` when a peer leaves, or its
  grace passes with no socket;
- to every peer, `{ "type": "closed" }` when the host leaves: the
  session is over. A peer on a socket is told and let go; one with no
  socket gets `4404` when it opens one.

## Sockets

The socket a frame comes down is its participant's from then on. A
client that gave up on a socket whose close never reached the relay dials
again by its `id`: the relay closes the earlier one and pushes what
waited. The relay closes `4404` the socket of a participant that left, was
removed or lost, or that it never knew (a failed upgrade tells a client
nothing it can read, so the request is let in and closed). It closes a
socket a push failed on with no code.

## Liveness

Only `leave` ends a participant at once. One whose socket closed
without it, the host too, may dial again by its `id` for a grace, 10 s
on `@vzn/vx-dte-server`, and is gone when the grace passes with no socket:
a peer as if it left, the host closing its session. The relay keeps no
timer and counts no heartbeat: it finds a grace passed as the session is
next used. A join whose socket never opened (its client dropped during
the upgrade) has the same grace from the join. A client whose socket drops dials again, and says its `leave`
again on a new socket if the first dropped under it.
`heartbeatMs` is how often participants should hear from each other: a
peer quiet on a socket that never closed is its peers' to lose. The
clients probe a quiet peer with an empty numbered send, which it
acknowledges at once, and lose one quiet for two `heartbeatMs`. A
numbered frame the relay leaves unanswered a heartbeat is a dead socket.

## Close codes

A refused request is let in and its socket closed with `4000 + status`,
said first in a `{ "close", "error" }` frame:

| Code   | Why                                                                        |
| ------ | -------------------------------------------------------------------------- |
| `4400` | a malformed request or join                                                |
| `4401` | no token, or an invalid one                                                |
| `4403` | a token the relay does not accept, or a host request not signed by its key |
| `4404` | an unknown, left or removed participant (and every socket it let go)       |
| `4406` | no version both speak; the reason names the relay's range                  |
| `4409` | a second host                                                              |
| `4410` | a closed session                                                           |
| `4413` | a join over 1 MiB                                                          |
| `4502` | the relay could not read the token issuer's keys; retry                    |
| `4503` | the relay's host refused the session (a plan's limit)                      |

A request that is no upgrade is answered its status and `{ "error" }`.

## Tokens

The relay checks the bearer token. `@vzn/vx-dte-server` takes CI OIDC
tokens: their signature by the issuer's published keys
(`<iss>/.well-known/openid-configuration`, then `jwks_uri`; RS256), `exp`
and `nbf`, an issuer it trusts, an `aud` naming its audience, and a
repository and workflow it allows (`403` else). Keys it cannot read
are the issuer's outage, not the token's fault: `502`, which a client
retries. Keys are read again once ten minutes old, so a key the issuer
withdraws stops admitting tokens, and for a key the relay does not hold
at most once a minute. A session is its id
within its token's issuer and repository claims (`repository_id` on
GitHub Actions, `project_id` on GitLab), so a tenant that learns another's
session id cannot open or join it.

## What the relay knows

A relay stores nothing. It writes no message, participant or session to
any file, database, key-value store or alarm: what it knows lives in
memory and in its open sockets, and a restart forgets it. Its host and
peers carry a session across one by joining it again. The one thing a
relay may cache is an issuer's published public keys (§ Tokens).

It holds only what routing needs, and no longer:

- A session is a SHA-256 of its id and its tokens' issuer and claims: no
  name says whose it is. A token is checked, never kept.
- A peer's `info` is held until the host is told it joined.
- A message is pushed or dropped, never held; a notice waits in memory.
- A closed session is gone at once; while open, each participant's role
  is kept, and when a socket dropped. A relay restart keeps a session whose
  host's socket, or a peer's naming that host, it kept; one whose host's
  socket it did not keep waits the grace from the restart.
- It logs nothing. It still sees each message's size, time and recipient.
