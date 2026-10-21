# @vzn/vx-dte-relay

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The reference relay for `@vzn/vx-dte`, which spreads one `vx run` over CI
agents. CI runners take no inbound connection, so the run's orchestrator
and its agents all dial out to a relay, which passes their messages on.
It admits only CI OIDC tokens of the pipeline that started the run.

The relay is one package with no dependencies, not even vx itself. Any
server that speaks [PROTOCOL.md](./PROTOCOL.md) can take its place.

## Run it

It is not on npm yet. From a checkout of this repo:

```sh
bun packages/vx-dte-relay/src/bin.ts --issuer https://gitlab.com --audience https://relay.example.com --port 8080
```

Or as a container, built from this directory:

```sh
docker build -t vx-dte-relay packages/vx-dte-relay
docker run -p 8080:8080 vx-dte-relay --issuer https://gitlab.com --audience https://relay.example.com
```

- `--issuer <url>` names an issuer whose tokens the relay trusts. Repeat
  it for more than one, such as a self-managed GitLab beside
  `https://token.actions.githubusercontent.com`.
- `--audience <aud>` is the `aud` every token must name: the URL the CI
  job asks its ID token for.
- `--port` (default 8080) and `--host` (default `0.0.0.0`) set where it
  listens.
- `--no-auth` admits every request. Use it only to try `@vzn/vx-dte`
  locally: it listens on loopback only.

Runs live in memory. Restarting the relay ends the runs it was carrying.

`createRelay()` and `createVerifier()` (`src/index.ts`) are the same relay
as a `fetch` handler, to mount in a server of your own.
