# `src/orchestrator/remote-cache-setup.ts` — env → LayeredCache

## Purpose

Inspect the runtime environment for `VX_REMOTE_CACHE_*` variables and,
if present, wrap the local cache in a `LayeredCache` that also pushes
to / pulls from the remote layer. Pure adapter — no I/O until the
orchestrator hits the cache.

## Public surface

```ts
export function wrapWithRemoteCache(local: Cache, log: Logger): CacheLayer
```

Returns either `local` unchanged (no remote configured) or a new
`LayeredCache(local, remote, { onRemoteError })`.

## Env contract

| Env var                      | Required | Default | Notes                                 |
| ---------------------------- | -------- | ------- | ------------------------------------- |
| `VX_REMOTE_CACHE_URL`        | yes      | —       | Both URL AND token required to opt-in |
| `VX_REMOTE_CACHE_TOKEN`      | yes      | —       | Bearer token sent on every request    |
| `VX_REMOTE_CACHE_TEAM_ID`    | no       | —       | Sent as `?teamId=` (Turbo tenancy)    |
| `VX_REMOTE_CACHE_SLUG`       | no       | —       | Sent as `?slug=`                      |
| `VX_REMOTE_CACHE_TIMEOUT_MS` | no       | `60000` | Positive finite integer               |

Missing or non-positive `VX_REMOTE_CACHE_TIMEOUT_MS` falls back to the
`RemoteCache` default.

## Logging

When the remote cache is wired up, `log.status('remote cache: <url>')`
runs once at setup. Per-request errors flow through the
`onRemoteError` callback to `log.status('[vx] remote cache: <msg>')`.
A flaky cache server doesn't fail the build; failures are noisy in
logs.

## Tests

`tests/layered-cache.test.ts` and `tests/orchestrator.test.ts`
cover the wrap behavior: env-set → reads + writes hit the stub
remote; env-unset → cache is the bare local instance.

## Why an env-only switch

A CLI flag (`--remote-cache-url <url>`) would duplicate the surface
and require sites that build deeper-down (CI scripts) to plumb it
through. Env vars are the standard tool for cache configuration in
CI; we don't want a second mechanism.

A future improvement could add `--token` / `--team` flags that
override env, matching Turbo's `--token` / `--team`. Tracked in
[`comparison.md`](../comparison.md).
