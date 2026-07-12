---
title: Remote caching
description: A local cache makes your own runs instant with zero setup. To share results across machines, a remote-cache plugin fills core's RemoteCacheLayer seam — the first-party shared cache is vx Cloud, and any other backend plugs in the same way.
---

A local cache makes *your* repeat runs instant, and it needs **no setup** —
it's on by default for every `vx run`. A **shared** cache extends that
across machines: CI restores what a teammate already built, and a fresh
clone is fast on its first run.

Sharing is the only part that needs a server. A solo developer needs
nothing here — the [local cache](../caching/) is automatic.

## Sharing is a plugin

Core ships **no HTTP cache client**. Sharing a cache is a **plugin
concern**: core defines a three-call `RemoteCacheLayer` seam
(`has`/`get`/`put`) and a `cache` plugin capability, and everything else —
read-through with local hydration, at-most-once in-flight deduplication,
background write-through uploads, and the never-fail contract — is core's
`LayeredCache`. A plugin provides the wire; `LayeredCache` provides the
behavior.

Reads try local first, then remote (hydrating local on a remote hit), with
a background prefetch pass that overlaps remote GETs with execution. Writes
go to local immediately; the remote upload is a fire-and-forget background
task drained at end of run — failures are logged but never fail the build.

## The first-party shared cache

The first-party remote cache is a self-hosted platform documented in its
own section. Connect a deployment and every `vx run` layers its shared
artifact store on top of the local cache automatically — the cache is
trust-scoped, so a fork PR can warm off `main` without being able to poison
a trusted build. See [Remote caching](../../cloud/remote-caching/) and the
[platform overview](../../cloud/overview/).

## Bring your own backend

Because the wire is a plugin, you can back the shared cache with
**anything** — your own server, a Turborepo-compatible cache, S3/R2, Redis
— with no platform involved. Implement core's `RemoteCacheLayer` seam and
wrap the local cache in `LayeredCache`; the runnable recipe (including a
Turbo-wire variant that speaks `/v8/artifacts/:hash`) is in
[Core is provider-neutral](../extensibility/#bring-your-own-remote-cache).
Embedders that already hold a client can inject it per-run via
`RunOptions.remoteCache` (explicit injection wins over the plugin consult).

## It never breaks your build

Whatever backend fills the seam, the remote cache is **fully optional at
runtime**. Any failure — a 500, a timeout, an auth error, a corrupt
artifact — degrades to a local cache miss and the run continues. A remote
outage slows you down; it never fails you.

## Artifact integrity

The vx-native `/v1/cache` wire attaches an `x-vx-digest` header — a
structural hash over the artifact bytes — to every upload; the client
verifies it against the received bytes on download, so a corrupt store or a
truncating proxy degrades to re-execution rather than restoring corrupt
outputs. A bring-your-own backend can adopt the same contract.

## In CI

Set the connection as CI secrets and you're done — see
[Continuous integration](../ci/) for a complete GitHub Actions example.
Pair the shared cache with `--affected` and most PRs only execute the
packages they actually changed; everything else restores from a previous
build.

## Next steps

- **[Continuous integration](../ci/)** — the full CI recipe.
- **[Core is provider-neutral](../extensibility/)** — the seam and a
  bring-your-own recipe.
- **[Caching deep dive](../../caching/)** — the artifact format and the
  layered cache.
