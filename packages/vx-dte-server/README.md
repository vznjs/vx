# @vzn/vx-dte-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The reference relay for `@vzn/vx-dte`, which spreads one `vx run` over
CI workers.

- CI runners take no inbound connection. So the run's orchestrator and
  its workers all dial out to a relay, which passes their messages on.
- It admits only CI OIDC tokens of the repositories it names.
- It binds each run to the repository that started it.

The relay is one package with one runtime dependency, not even vx
itself:

- That dependency is [`@vzn/vx-devtools`](../vx-devtools/README.md), the
  CI token check every vx server shares. It imports only `jose`.
- The relay speaks the [Switchboard protocol](./PROTOCOL.md)
  (`switchboard.v1`).
- One host, the run's orchestrator, and its peers, the workers, meet
  behind one relay.
- Any server that speaks the protocol can take its place, and any tool
  can use it.

## Run it

### On Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vznjs/vx/tree/main/packages/vx-dte-server)

The button copies this directory into a new repository of yours and
deploys it. It asks for one var, `ALLOW`: who may take part.

- `ALLOW` is space separated, each entry `issuer:owner/repo:workflow`.
- `ALLOW` names repositories, not ids: if an owner is renamed and someone takes the old name, their jobs get in. Update `ALLOW` when you rename an owner or repository.
- It is not a secret: keep it in your copy's `wrangler.jsonc`, since
  each deploy sets vars from that file.
- `https://token.actions.githubusercontent.com:vznjs/vx:ci.yml` admits
  the jobs of `.github/workflows/ci.yml` in `vznjs/vx`.
- `https://gitlab.com:group/project:.gitlab-ci.yml` admits a GitLab
  project's.
- Repeat an entry for each repository and workflow, the orchestrator's
  and the workers'. Every other token is refused.
- The relay's URL is the Cloudflare Worker's URL, such as
  `https://vx-dte-server.<you>.workers.dev`. Name it as `relay` in
  `dte()`.

Or deploy from this directory with Cloudflare's
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/):

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Set `ALLOW` in `wrangler.jsonc`'s `vars` first.

`src/worker.ts` is the same relay as the one on Bun. It fits Workers'
free plan.

- Each run is one Durable Object, so its sockets meet in one place.
- Participants hold websockets, which the object hibernates between
  messages.
- The run is kept in the sockets' attachments; the object writes no
  storage.
- It sets no alarm and counts no heartbeat. A socket's close loses its
  participant.
- A peer quiet on a socket that never closed is its peers' to lose.
- Issuers' keys are read once per isolate and held ten minutes in the
  data center's cache. So a run's object does not fetch them again.
- A token naming a key they lack is checked against a fresh read.
- Each participant joins on the socket it opens: one request.
- Its websocket messages count 20 to one Durable Object request, against
  100 000 a day. It writes no row.

`wrangler.jsonc` sets the rest. Change a value there, in the repository
the button made, or in the Worker's settings in the Cloudflare
dashboard:

- `AUDIENCE`, unset, is the URL the relay is reached at. Set it only
  when tokens name another one.
- Blanks around `AUDIENCE` are dropped, and a blank one is refused, as
  on Bun.

### On Bun

```sh
ALLOW=https://gitlab.com:group/app:.gitlab-ci.yml AUDIENCE=https://relay.example.com \
bunx @vzn/vx-dte-server --port 8080
```

Or as a container:

```sh
docker run -p 8080:8080 -e ALLOW=https://gitlab.com:group/app:.gitlab-ci.yml \
  -e AUDIENCE=https://relay.example.com ghcr.io/vznjs/vx-dte-server
```

All vx servers at once, this relay included:
[`private/vx-servers/compose.yaml`](../../private/vx-servers/compose.yaml)
(`docker compose up`). The relay stores nothing, so it needs no volume.

- `ALLOW` is the same list as on Workers (above), read from the
  environment as every vx server reads it.
- GitLab names a project by its full path, `group/subgroup/project`.
- `AUDIENCE` is the `aud` every token must name: the URL the CI job
  asks its ID token for, with or without a trailing slash.
- `--port` (default 8080) and `--host` (default `0.0.0.0`) set where it
  listens.
- `--no-auth` admits every request. Use it only to try `@vzn/vx-dte`
  locally: it listens on loopback only.

CI builds this image and carries one run through it (`test.docker`).

- Runs live in memory. A restarted relay forgets the runs it was
  carrying, and vx-dte joins each again.
- Participants hold websockets here too, so a message reaches its
  receiver the moment it is sent.
- Each participant is one socket and one file descriptor.
- Bun raises the open-file limit to the container's hard limit (Docker's
  is 524288 or more), so it never needs a `--ulimit`.

Measured on 4 cores, 10,000 sockets over 100 runs:

- They take 41 MB over an idle relay, about 4 KB each, and 6% of a core
  idle.
- With each worker sending one message a second (10,000 a second), they
  take 43% of a core, every message delivered.

## Environment

- `RELAY`: on Workers, the `RelayRun` Durable Object binding
  (`wrangler.jsonc`); the relay refuses every request without it.
- `NO_COLOR`, then `FORCE_COLOR`, then a terminal whose `TERM` is not
  dumb: whether the Bun relay's status lines print in colour.

## API

The same relay as a `fetch` handler, to mount in a server of your own
(`src/index.ts`):

- `createRelay(options?: RelayOptions): Relay`.
- `RelayOptions` is `{ verify?, heartbeatMs?, graceMs? }`:
  - `verify` checks a request's bearer token and gets the request too.
    None admits every request.
  - `heartbeatMs` (default 2000) is how often participants hear from
    each other, said in each join's answer.
  - `graceMs` (default 10 000) is how long a participant whose socket
    dropped without `leave` may dial again before it is gone
    (PROTOCOL.md § Liveness).
- A `Relay` is `{ fetch(req) }`, plus the hooks a host of websockets
  drives. `src/worker.ts` is their user.

<details>
<summary>Details: the websocket hooks</summary>

- The option `sockets` is the `[Kept, RelaySocket]` pairs a host kept
  across a restart. The sessions are rebuilt from them (PROTOCOL.md
  § What the relay knows).
- The option `upgrade` answers a `socket` request.
- The methods `attach` and `detach` hand the relay a participant's
  `RelaySocket` (`{ send, close }`).
- `detach` means its socket closed: the participant is gone unless it
  dials again within `graceMs`.
- `frame` returns the answer to send down the socket, or `undefined` for
  none.
- `attach` returns the `Kept` its host keeps with the socket, or
  `false`.
- `Kept` is a Durable Object's attachment: session, id, role, the host's
  key, and a peer's host's id.
- A host closes a socket `attach` refuses with
  `closeSocket(socket, GONE)` (`GONE` is 4404).
- That says the close in a frame first (PROTOCOL.md § Sockets).

</details>

- `serveRelay(options: ServeOptions): RelayServer` serves the relay on
  `Bun.serve`, websockets included.
  - `ServeOptions` is `{ hostname, port, verify?, heartbeatMs? }`.
  - A `RelayServer` is `{ url, stop() }`.
- `createProver(): Promise<Prover>` makes the host's key for one
  session (PROTOCOL.md § The host's key).
  - A `Prover` is `{ key, proof(method, path, body) }`.
  - `key` is what its `join` names.
  - `proof` is the value of the `PROOF_HEADER` (`relay-proof`) header of
    each request as the host.
- `createVerifier(options: OidcOptions)` returns that `verify`:
  `@vzn/vx-devtools`' `oidcClaims`, then the run claims.
- `OidcOptions` is `{ allow, audience, runClaims?, fetchJson?, now? }`:
  - `allow` is who may take part, devtools' `Admits`,
    `{ issuer, repository?, workflow? }`. An unset part admits any.
  - `parseAllow` from devtools reads `ALLOW` into them.
  - `audience` is the `aud` a token must name.
  - `runClaims` is the run claims per issuer, default `runClaimsOf(iss)`.
  - `fetchJson` and `now` are a key reader and clock for tests.
- The verifier resolves a `VerifiedToken`, `{ iss, run }`.
- Or it rejects with devtools' `Refusal` carrying the `status` the relay
  answers: 401, 403, or 502 when the issuer's keys cannot be read.
- `runClaimsOf(iss)` names the claims that bind a run: `repository_id`
  for GitHub Actions, `project_id` otherwise.
