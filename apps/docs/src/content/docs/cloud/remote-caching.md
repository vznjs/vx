---
title: Remote caching
description: Share a cache across machines by connecting a vx Cloud deployment. The remote cache is part of that one connection — trust-scoped so a fork PR can warm off main without poisoning it, and never able to fail your build.
---

A local cache makes *your* repeat runs instant with zero setup — it's on
by default for every `vx run`. A **shared** cache extends that across
machines: CI restores what a teammate already built, and a fresh clone is
fast on its first run. Sharing is the only part that needs a server.

vx Cloud is the first-party shared cache. (Core exposes a provider-neutral
seam, so you can also bring your own backend — see
[Remote caching (core)](/vx/guides/remote-caching/) and
[Core is provider-neutral](/vx/guides/extensibility/).)

## The one connection

Sharing a cache means connecting to a vx Cloud deployment — the
[self-hosted platform](/vx/cloud/self-hosting/) that hosts the artifact
store (plus the dashboard and, optionally,
[distributed execution](/vx/cloud/distributed-ci/)). **One connection
provides all of it.** The remote cache is *internal* to that connection:
connect a platform and every `vx run` reads and writes its artifact store
automatically — there is **no** separate cache URL or token to configure.

Persist the connection once (`$VX_CLOUD_TOKEN` is an API token you minted
under **Admin → Tokens** on the platform):

```bash
vx-cloud connect https://vx-cloud.example.com --token "$VX_CLOUD_TOKEN"
```

or set it with two environment variables (handy in CI):

```bash
export VX_CLOUD_URL=https://vx-cloud.example.com
export VX_CLOUD_TOKEN=your-token
```

Either way, `vx run` now layers the platform's cache on top of the local
one (local first, then remote, then execute; remote hits hydrate the local
cache). Don't have a server yet? It's one `docker compose up` — see
[Self-hosting](/vx/cloud/self-hosting/).

### The connection variables

| Variable | Purpose |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `VX_CLOUD_URL` | The deployment origin. Drives the cache, analytics ingest, and distributed execution. |
| `VX_CLOUD_TOKEN` | Bearer token for a **trusted** context (reads and writes the trusted cache scope). |
| `VX_CLOUD_PR_TOKEN` | Bearer token for a **fork-PR** context (reads trusted, writes only untrusted — see below). |

That's the whole surface. The cache, the dashboard, and distributed
execution all ride this one connection — there is no separate cache-only
variable.

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

## Artifact integrity

Every artifact upload carries an `x-vx-digest` header — a structural hash
over the artifact bytes. The server stores it and echoes it back on
download, and the **client verifies** it against the received bytes: a
corrupt store, a truncating proxy, or a bad disk degrades to re-execution —
it never restores corrupt outputs. This is always on; there is nothing to
configure.

## In CI

Set the connection as CI secrets and you're done — see
[Continuous integration](/vx/guides/ci/) for a complete GitHub Actions
example. Pair the shared cache with `--affected` and most PRs only execute
the packages they actually changed; everything else restores from a
previous build.

## Next steps

- **[Self-hosting](/vx/cloud/self-hosting/)** — stand up the server in one
  `docker compose up`.
- **[Distributed CI](/vx/cloud/distributed-ci/)** — fan a run across an
  agent pool over the same connection.
- **[Caching deep dive](/vx/caching/)** — the artifact format and the
  layered cache.
