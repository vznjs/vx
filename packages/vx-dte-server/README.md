# @vzn/vx-dte-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The reference relay for `@vzn/vx-dte`, which spreads one `vx run` over CI
workers. CI runners take no inbound connection, so the run's orchestrator
and its workers all dial out to a relay, which passes their messages on.
It admits only CI OIDC tokens of the repositories it names, and binds
each run to the repository that started it.

The relay is one package whose one runtime dependency is `jose`, which checks
the CI tokens; not even vx itself. It speaks the
[Switchboard protocol](./PROTOCOL.md) (`switchboard.v1`): one host, the
run's orchestrator, and its peers, the workers, behind one relay. Any
server that speaks it can take its place, and any tool can use it.

## Run it

### On Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vznjs/vx/tree/main/packages/vx-dte-server)

The button copies this directory into a new repository of yours and
deploys it. It asks for one var, `ALLOW`: who may take part, space
separated, each `issuer:owner/repo:workflow`. It is not a secret: keep it
in your copy's `wrangler.jsonc`, since each deploy sets vars from that file.
`https://token.actions.githubusercontent.com:vznjs/vx:ci.yml` admits the
jobs of `.github/workflows/ci.yml` in `vznjs/vx`;
`https://gitlab.com:group/project:.gitlab-ci.yml` a GitLab project's.
Repeat an entry for each repository and workflow, the orchestrator's and
the workers'. Every other token is refused. The relay's URL is the Cloudflare Worker's URL, such
as `https://vx-dte-server.<you>.workers.dev`. Name it as `relay` in
`dte()`.

Or deploy from this directory with Cloudflare's
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/):

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Set `ALLOW` in `wrangler.jsonc`'s `vars` first.

`src/worker.ts` is the same relay as the one on Bun. Each run is one
Durable Object, so its sockets meet in one place. Participants hold
websockets, which the object hibernates between messages: the run is kept
in their attachments, and the object writes no storage. It sets no alarm and counts no heartbeat: a
socket's close loses its participant, and a peer quiet on a socket that
never closed is its peers' to lose. Issuers' keys
are read once per isolate and held ten minutes in the data center's
cache, so a run's object does not fetch them again; a token naming a key
they lack is checked against a fresh read.
It fits Workers' free plan: each participant joins on the socket it
opens, one request, and its websocket messages count 20 to one Durable
Object request, against 100 000 a day; it writes no row.
`wrangler.jsonc` sets the rest; change a value there, in the repository
the button made, or in the Worker's settings in the Cloudflare dashboard:

- `AUDIENCE`, unset, is the URL the relay is reached at. Set it only
  when tokens name another one. Blanks around it are dropped, and a
  blank one is refused, as on Bun.

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

All vx servers at once, this relay with its state on a volume included:
[`private/vx-servers/compose.yaml`](../../private/vx-servers/compose.yaml)
(`docker compose up`).

- `ALLOW` is the same list as on Workers (above), read from the
  environment as every vx server reads it. GitLab names a project by
  its full path, `group/subgroup/project`.
- `AUDIENCE` is the `aud` every token must name: the URL the CI job
  asks its ID token for.
- `--port` (default 8080) and `--host` (default `0.0.0.0`) set where it
  listens.
- `--no-auth` admits every request. Use it only to try `@vzn/vx-dte`
  locally: it listens on loopback only.

CI builds this image and carries one run through it (`test.live`).

Runs live in memory. A restarted relay forgets the runs it was carrying,
and vx-dte joins each again.
Participants hold websockets here too, so a message reaches its receiver
the moment it is sent.

Each participant is one socket and one file descriptor. Bun raises the
open-file limit to the container's hard limit (Docker's is 524288 or
more), so it never needs a `--ulimit`. Measured on 4 cores (2026-10-24):
10,000 sockets over 100 runs take 41 MB over an idle relay (about 4 KB
each) and 6% of a core idle; with each worker sending one message a
second (10,000 a second) 43% of a core, every message delivered.

## API

The same relay as a `fetch` handler, to mount in a server of your own
(`src/index.ts`):

- `createRelay(options?: RelayOptions): Relay`. `RelayOptions` is
  `{ verify?, heartbeatMs?, graceMs? }`: `verify` checks a request's bearer token
  (none admits every request) and gets the request too, `heartbeatMs` (default 2000) is how often
  participants hear from each other, said in each join's answer, and
  `graceMs` (default 10 000) how long a participant whose socket dropped
  without `leave` may dial again before it is gone (PROTOCOL.md § Liveness). A `Relay` is `{ fetch(req) }`,
  plus the hooks a host of websockets drives (`src/worker.ts` is their
  user): the options `sockets`, the `[Kept, RelaySocket]` pairs a host
  kept across a restart, from which the sessions are rebuilt (PROTOCOL.md
  § What the relay knows), and `upgrade`, which answers a `socket`
  request; and the methods `attach` and `detach` (its socket closed: the
  participant is gone unless it dials again within `graceMs`), which hand the relay a participant's
  `RelaySocket` (`{ send, close }`), and `frame`, which returns the
  answer to send down the socket, or `undefined` for none. `attach`
  returns the `Kept` its host keeps with the socket (a Durable Object's
  attachment: session, id, role, the host's key, and a peer's host's id), or
  `false`. A host closes a socket `attach` refuses
  with `closeSocket(socket, GONE)` (`GONE` is 4404), which says the close in a frame first
  (PROTOCOL.md § Sockets).
- `serveRelay(options: ServeOptions): RelayServer` serves the relay on
  `Bun.serve`, websockets included. `ServeOptions` is
  `{ hostname, port, verify?, heartbeatMs? }`, and a `RelayServer` is
  `{ url, stop() }`.
- `createProver(): Promise<Prover>` makes the host's key for one
  session (PROTOCOL.md § The host's key). A `Prover` is
  `{ key, proof(method, path, body) }`: `key` is what its `join` names,
  and `proof` is the value of the `PROOF_HEADER` (`relay-proof`) header of
  each request as the host.
- `createVerifier(options: OidcOptions)` returns that `verify`.
  `OidcOptions` is
  `{ allow, audience, runClaims?, fetchJson?, now? }`: who may take part,
  `Allowed`s `{ issuer, repository?, workflow? }` (an unset part admits
  any; a token's `repositoryClaimOf(iss)` and `workflowClaimOf(iss)` up to
  its `@` are matched without case), the `aud` a token must name, run claims per issuer (default
  `runClaimsOf(iss)`), and a key reader and clock for tests. It
  resolves a `VerifiedToken`, `{ iss, run }`, or rejects with a
  `TokenError` carrying the `status` (401 or 403) the relay answers.
- `parseAllow(list)` reads `ALLOW`'s entries into `Allowed`s, each
  `issuer:owner/repo:workflow` read from the right (an issuer holds `:`s),
  or throws naming the entry it cannot read. An issuer is `https://`, or
  plain `http://` only to `127.0.0.1`, as the cache and history servers read it.
- `runClaimsOf(iss)` names the claims that bind a run: `repository_id`
  for GitHub Actions, `project_id` otherwise.
- `repositoryClaimOf(iss)` names the claim that names a token's
  repository: `repository` for GitHub Actions, `project_path` otherwise.
- `workflowClaimOf(iss)` names the claim that names the workflow a
  token's job is defined in: `job_workflow_ref` for GitHub Actions,
  `ci_config_ref_uri` otherwise.
