# @vzn/vx-dte-relay

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The reference relay for `@vzn/vx-dte`, which spreads one `vx run` over CI
agents. CI runners take no inbound connection, so the run's orchestrator
and its agents all dial out to a relay, which passes their messages on.
It admits only CI OIDC tokens of the repositories it names, and binds
each run to the repository that started it.

The relay is one package with no runtime dependencies, not even vx itself. Any
server that speaks [PROTOCOL.md](./PROTOCOL.md) can take its place.

## Run it

### On Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vznjs/vx/tree/main/packages/vx-dte-relay)

The button copies this directory into a new repository of yours and
deploys it. It asks for one value, `REPOSITORIES`: the repositories whose
CI runs the relay carries, as `owner/repo`, comma separated. Every other
repository's token is refused. The relay's URL is the worker's URL, such
as `https://vx-dte-relay.<you>.workers.dev`. Name it as `relay` in
`dte()`.

Or deploy from this directory with Cloudflare's
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/):

```sh
npm install
npx wrangler login
npx wrangler deploy
echo owner/repo | npx wrangler secret put REPOSITORIES
```

`src/worker.ts` is the same relay as the one on Bun. Each run is one
Durable Object, so its mailboxes live in one place. Participants hold
websockets, which the object hibernates between messages: the run is kept
in the object's storage, the runtime answers heartbeats without waking
it, and an alarm finds the participants that went silent.
`wrangler.jsonc` sets the rest; change a value there, in the repository
the button made, or in the Worker's settings in the Cloudflare dashboard:

- `ISSUERS` (comma separated) is GitHub Actions' issuer. Add
  `https://gitlab.com`, or a self-managed GitLab, to carry GitLab's runs.
- `WORKFLOWS`, empty, admits any workflow of `REPOSITORIES`. Name
  workflows, comma separated, to admit only their jobs:
  `owner/repo/.github/workflows/ci.yml` on GitHub (a reusable workflow
  by its own path), `gitlab.com/group/project//.gitlab-ci.yml` on
  GitLab, any ref. List the orchestrator's workflow and the agents'.
- `AUDIENCE`, unset, is the URL the relay is reached at. Set it only
  when tokens name another one.

### On Bun

It is not on npm yet. From a checkout of this repo:

```sh
bun packages/vx-dte-relay/src/bun.ts --issuer https://gitlab.com --repository group/app --audience https://relay.example.com --port 8080
```

Or as a container, built from this directory:

```sh
docker build -t vx-dte-relay packages/vx-dte-relay
docker run -p 8080:8080 vx-dte-relay --issuer https://gitlab.com --repository group/app --audience https://relay.example.com
```

- `--issuer <url>` names an issuer whose tokens the relay trusts. Repeat
  it for more than one, such as a self-managed GitLab beside
  `https://token.actions.githubusercontent.com`.
- `--repository <owner/repo>` names a repository whose runs the relay
  carries; repeat it for more. A token of any other is refused. GitLab
  names a project by its full path, `group/subgroup/project`.
- `--workflow <path>`, repeated, admits only jobs of these workflows
  (`WORKFLOWS` above); unset, any.
- `--audience <aud>` is the `aud` every token must name: the URL the CI
  job asks its ID token for.
- `--port` (default 8080) and `--host` (default `0.0.0.0`) set where it
  listens.
- `--no-auth` admits every request. Use it only to try `@vzn/vx-dte`
  locally: it listens on loopback only.

Runs live in memory. Restarting the relay ends the runs it was carrying.
Participants hold websockets here too, so a message reaches its receiver
the moment it is sent.

## API

The same relay as a `fetch` handler, to mount in a server of your own
(`src/index.ts`):

- `createRelay(options?: RelayOptions): Relay`. `RelayOptions` is
  `{ verify?, heartbeatMs? }`: `verify` checks a request's bearer token
  (none admits every request) and gets the request too, `heartbeatMs` (default 5000) is how often
  a participant must be heard from. A `Relay` is `{ fetch(req), close() }`,
  plus the hooks a host of websockets drives (`src/worker.ts` is their
  user): the options `store`, a `RelayStore` (`{ put, delete, list }`,
  a Durable Object's `storage.kv`) that keeps runs across a restart,
  `upgrade`, which answers a `socket` request, and `timer: false`, so the
  host calls `sweep()` itself; and the methods `attach` and `detach`,
  which hand the relay a participant's `RelaySocket` (`{ send, close }`),
  `frame`, `seen` and `sweep`.
- `serveRelay(options: ServeOptions): RelayServer` serves the relay on
  `Bun.serve`, websockets included. `ServeOptions` is
  `{ hostname, port, verify?, heartbeatMs? }`, and a `RelayServer` is
  `{ url, stop() }`.
- `createProver(): Promise<Prover>` makes the orchestrator's key for one
  run (PROTOCOL.md § The orchestrator's key). A `Prover` is
  `{ key, proof(method, path, body) }`: `key` is what its `join` names,
  and `proof` is the value of the `PROOF_HEADER` (`vx-proof`) header of
  each request as the orchestrator.
- `createVerifier(options: OidcOptions)` returns that `verify`.
  `OidcOptions` is
  `{ issuers, audience, repositories?, workflows?, runClaims?, fetchJson?, now? }`:
  the trusted issuers, the `aud` a token must name,
  the `owner/repo`s a token's `repositoryClaimOf(iss)` must name (matched
  without case; unset, none is checked), the workflows its
  `workflowClaimOf(iss)` must name up to its `@` (unset or empty, any), run claims per issuer (default
  `runClaimsOf(iss)`), and a key reader and clock for tests. It
  resolves a `VerifiedToken`, `{ iss, run, job? }` (`job`, the CI job it
  is from, pins a run's orchestrator), or rejects with a
  `TokenError` carrying the `status` (401 or 403) the relay answers.
- `runClaimsOf(iss)` names the claims that bind a run: `repository_id`
  for GitHub Actions, `project_id` otherwise.
- `repositoryClaimOf(iss)` names the claim that names a token's
  repository: `repository` for GitHub Actions, `project_path` otherwise.
- `workflowClaimOf(iss)` names the claim that names the workflow a
  token's job is defined in: `job_workflow_ref` for GitHub Actions,
  `ci_config_ref_uri` otherwise.
