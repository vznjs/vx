---
title: Remote caching
description: A local cache makes your own runs instant with zero setup. To share results across machines, connect a vx-cloud — the remote cache is part of that one connection. vx also speaks the Turborepo artifact wire, so a third-party cache server works too.
---

A local cache makes *your* repeat runs instant, and it needs **no setup** —
it's on by default for every `vx run`. A **shared** cache extends that
across machines: CI restores what a teammate already built, and a fresh
clone is fast on its first run.

Sharing is the only part that needs a server. A solo developer needs
nothing here — the [local cache](../caching/) is automatic.

## The one connection

Sharing a cache means connecting to a **vx-cloud** — a small server that
hosts the artifact store (plus the dashboard and, optionally,
[distributed execution](../distributed-ci/)). **One connection provides all
of it.** The remote cache is *internal* to that connection: connect a cloud
and every `vx run` reads and writes its artifact store automatically —
there is **no** separate cache URL or token to configure.

Persist the connection once:

```bash
vx-cloud connect https://vx-cloud.example.com --token "$VX_CLOUD_TOKEN"
```

or set it with two environment variables (handy in CI):

```bash
export VX_CLOUD_URL=https://vx-cloud.example.com
export VX_CLOUD_TOKEN=your-token
```

Either way, `vx run` now layers the cloud's cache on top of the local one
(local first, then remote, then execute; remote hits hydrate the local
cache). Don't have a server yet? It's one `docker compose up` — see
[Self-host vx-cloud](../self-hosting/).

### The connection variables

| Variable            | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `VX_CLOUD_URL`      | The vx-cloud origin. Drives the cache, analytics ingest, and distributed execution.         |
| `VX_CLOUD_TOKEN`    | Bearer token for a **trusted** context (reads and writes the trusted cache scope).          |
| `VX_CLOUD_PR_TOKEN` | Bearer token for a **fork-PR** context (reads trusted, writes only untrusted — see below).  |

That's the whole surface. The cache, the dashboard, and distributed
execution all ride this one connection — you do **not** set
`VX_REMOTE_CACHE_URL` for a vx-cloud.

## Trust follows the token

The cache is **trust-scoped**, and the tier is decided by **which token you
present** — the server derives it from the bearer, never from a client
claim:

- **`VX_CLOUD_TOKEN`** — a trusted context (your `main` builds, protected
  branches). Reads and writes the trusted scope.
- **`VX_CLOUD_PR_TOKEN`** — a fork-PR context. Reads the trusted scope (so
  the PR still warms off `main`) but writes **only** the untrusted scope, so
  a fork can never poison a trusted build. It's safe to expose.

There's no separate trust flag and no autodetection: a fork PR simply
doesn't have your repo secrets, so the only token it holds is the PR token —
which token you have *is* the tier. Present the PR token from fork-PR jobs;
present the trusted token everywhere else.

## It never breaks your build

The remote cache is **fully optional at runtime**. Any failure — a 500, a
timeout, an auth error, a corrupt artifact — degrades to a local cache miss
and the run continues. A remote outage slows you down; it never fails you.
Remote lookups also fire concurrently in the background before scheduling,
so network latency overlaps execution.

## A third-party cache server (Turbo-compatible)

Don't want to run a vx-cloud? vx speaks Turborepo's `/v8/artifacts/` wire
verbatim, so you can point it at any Turbo-compatible cache server instead.
This is the **secondary** path — a shared cache with no dashboard and no
distribution. Configure it with the `VX_REMOTE_CACHE_*` variables:

```bash
export VX_REMOTE_CACHE_URL=https://your-cache-server.example.com
export VX_REMOTE_CACHE_TOKEN=your-token
```

Compatible servers:

- [`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache)
- [`Fox32/openturbo-remote-cache`](https://github.com/Fox32/openturbo-remote-cache)
- Vercel's hosted Turborepo cache

Optional extras on this path:

| Variable                        | Purpose                                       |
| ------------------------------- | --------------------------------------------- |
| `VX_REMOTE_CACHE_PR_TOKEN`      | Fork-PR token (reads trusted, writes untrusted). |
| `VX_REMOTE_CACHE_TEAM_ID`       | Tenant id (`teamId=` query param).            |
| `VX_REMOTE_CACHE_SLUG`          | Tenant slug (`slug=` query param).            |
| `VX_REMOTE_CACHE_TIMEOUT_MS`    | Per-request timeout.                          |
| `VX_REMOTE_CACHE_SIGNATURE_KEY` | Enable HMAC artifact signing (see below).     |

When you connect a vx-cloud, ignore all of these — the connection already
provides the cache. They're **only** for a non-vx-cloud server.

## Signed artifacts (optional, stricter)

Set a signature key and vx signs every uploaded artifact with HMAC-SHA256
(the Turborepo-compatible `x-artifact-tag` header) and **verifies** every
downloaded one:

```bash
export VX_REMOTE_CACHE_SIGNATURE_KEY=a-shared-secret
```

This works on either path — a vx-cloud connection or a third-party server.
With a key configured, vx **rejects an unsigned response** — a server or
proxy can't strip the tag to slip an unsigned artifact past you. A tampered
artifact fails verification and degrades to re-execution; it never corrupts
your build. Set the same key on every machine that shares the cache.

## In CI

Set the connection as CI secrets and you're done — see
[Continuous integration](../ci/) for a complete GitHub Actions example.
Pair the shared cache with `--affected` and most PRs only execute the
packages they actually changed; everything else restores from a previous
build.

## Next steps

- **[Continuous integration](../ci/)** — the full CI recipe.
- **[Self-host vx-cloud](../self-hosting/)** — stand up the server in one
  `docker compose up`.
- **[Caching deep dive](../../caching/)** — the artifact format and the
  layered cache.
