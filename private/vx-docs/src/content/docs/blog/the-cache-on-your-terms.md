---
title: 'The cache on your terms'
date: 2026-10-09T06:00:00Z
authors:
  - vzn
tags:
  - caching
  - ci
excerpt: 'Turn the cache off, refresh it, or read one layer and write another. Every clone and worktree of a repo shares one store. And a pull request never writes what main reads.'
---

A cache is only useful when you can tell it what to do. vx gives you three
switches for a run, one store for every checkout, and a scope that keeps
untrusted runs from writing what everyone else reads.

## Three switches

```sh frame="terminal"
$ vx run build --all
  cache     local 4✓
  time      15ms

$ vx run build --all --force
  cache     local 4↑
  time      56ms

$ vx run build --all --no-cache
  cache     local 4∅
  time      42ms
```

`--force` runs everything again and saves what the cache lacks. A key
already stored, locally or in a remote, is kept as it is and not
uploaded again.
`--no-cache` neither reads nor writes. For finer control, `--cache-policy` takes
a read/write spec per layer:

```sh frame="terminal"
$ vx run build --all --cache-policy=local:rw,remote:r   # read the remote, never upload
$ vx run build --all --cache-policy=local:r             # read local, write nothing local
$ vx run build --all --cache-policy=local:,remote:rw    # skip local, still upload
```

`VX_CACHE_POLICY` sets the same spec for every run in a shell or CI job, and
`cache.policy` in `.vx/workspace.ts` sets the default; the flag beats the
variable, which beats the config. Whatever the spec, a lookup asks the
local cache first, then each remote in the order the plugins declare them.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({ cache: { policy: 'local:rw,remote:r' } })
```

An empty spec is refused, never read as "everything on":

```sh frame="terminal"
$ vx run build --all --cache-policy=
✗ vx run  --cache-policy needs a spec like local:r, local:rw, remote:, or local:,remote:rw — pass --no-cache to disable every axis

  see vx run --help
```

## One store for every checkout

Artifacts live in `~/.vx/<id>/cache`, where the id comes from the repo's
remote. Each checkout keeps only its own small index. So a second clone
or a fresh `git worktree` hits what the first one built:

```sh frame="terminal"
$ git worktree add ../demo-wt && cd ../demo-wt
$ vx run build --all
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 4↓
  time      30ms
```

The new worktree had no `dist`. All four builds came back from the shared
store in 30 ms. To put the cache somewhere else, use `--cache-dir`,
`VX_CACHE_DIR` or `cache.dir` in `.vx/workspace.ts`.

## Who may write the remote cache

A remote cache is shared, so a write is a promise to everyone who reads
it. Two settings decide it. The policy says whether a run writes at
all: off CI the default reads the remote and writes nothing. The cache
server says where a write lands:

```mermaid
flowchart LR
  M[main CI] -->|reads + writes| T[(trusted)]
  P[PR CI · feat-x] -->|reads| T
  P -->|reads + writes| S[(feat-x)]
  L[laptop on feat-x] -->|reads| S
  L -->|reads| T
  style T stroke:#c6f84e,stroke-width:2px
```

- The CI OIDC token, checked against the server's trust policy, decides
  where a write lands: trusted, the token's own branch, or nowhere.
- `turboCache()` names the branches a read may see, own first, and the
  server answers from the first that holds the key. A pull request never
  writes what main reads.
- The local cache never knows a branch, so the same inputs hit locally
  on any branch.

[Branch caches a server enforces](../branch-caches-a-server-enforces/)
shows how a server builds its half.

Outputs above: demo workspace, vx at `4c308fb`, 2026-10-23. Every flag
is in the [CLI reference](../../cli/), and `cache` is in the
[schema](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
