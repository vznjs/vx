---
title: Remote caching
description: Share the cache across machines and CI with two environment variables. vx speaks the Turborepo artifact wire, so existing cache servers work unchanged — with optional HMAC signing.
---

A local cache makes *your* repeat runs instant. A **remote** cache shares
those results across every machine — so CI builds what a teammate already
built, and a fresh clone is fast on the first run. vx's remote cache is
opt-in, configured entirely with environment variables, and **wire-
compatible with Turborepo**, so existing cache servers work without a
shim.

## Turn it on

Set two variables and remote caching is active:

```bash
export VX_REMOTE_CACHE_URL=https://your-cache-server.example.com
export VX_REMOTE_CACHE_TOKEN=your-token
```

That's it — `vx run` now reads from and writes to the remote cache,
layered on top of the local one (local first, then remote, then execute;
remote hits hydrate the local cache).

### All the variables

| Variable                          | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `VX_REMOTE_CACHE_URL`             | Cache server base URL. **Required.**                 |
| `VX_REMOTE_CACHE_TOKEN`           | Bearer token. **Required.**                          |
| `VX_REMOTE_CACHE_TEAM_ID`         | Tenant id (`teamId=` query param).                   |
| `VX_REMOTE_CACHE_SLUG`            | Tenant slug (`slug=` query param).                   |
| `VX_REMOTE_CACHE_TIMEOUT_MS`      | Per-request timeout.                                 |
| `VX_REMOTE_CACHE_SIGNATURE_KEY`   | Enable HMAC artifact signing (see below).            |

## It never breaks your build

The remote cache is **fully optional at runtime**. Any failure — a 500, a
timeout, an auth error, a corrupt artifact — degrades to a local cache
miss and the run continues. A remote outage slows you down; it never
fails you. Remote lookups also fire concurrently in the background before
scheduling, so network latency overlaps execution.

## Compatible servers

vx speaks Turborepo's `/v8/artifacts/` wire verbatim, so these work
as-is:

- [`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache)
- [`Fox32/openturbo-remote-cache`](https://github.com/Fox32/openturbo-remote-cache)
- Vercel's hosted Turborepo cache

Point `VX_REMOTE_CACHE_URL` at any of them.

## Signed artifacts (optional, stricter)

Set a signature key and vx signs every uploaded artifact with HMAC-SHA256
(the Turborepo-compatible `x-artifact-tag` header) and **verifies** every
downloaded one:

```bash
export VX_REMOTE_CACHE_SIGNATURE_KEY=a-shared-secret
```

With a key configured, vx **rejects an unsigned response** — a server or
proxy can't strip the tag to slip an unsigned artifact past you. A
tampered artifact fails verification and degrades to re-execution; it
never corrupts your build. Set the same key on every machine that shares
the cache.

## In CI

Set the variables as CI secrets and you're done — see
[Continuous integration](../ci/) for a complete GitHub Actions example.
Pair remote caching with `--affected` and most PRs only execute the
packages they actually changed; everything else restores from a previous
build.

## Next steps

- **[Continuous integration](../ci/)** — the full CI recipe.
- **[Caching deep dive](../../caching/)** — the artifact format and the
  layered cache.
