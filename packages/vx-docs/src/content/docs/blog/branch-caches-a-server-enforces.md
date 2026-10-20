---
title: 'Branch caches a server enforces'
date: 2026-10-20T12:00:00Z
authors:
  - vzn
tags:
  - caching
  - ci
excerpt: 'A pull request should read what main built and never write where main reads. vx keeps task keys plain and lets the cache server decide: the CI token picks where a write lands, a header names which branches a read may see. How it works, and how a cache server builds its half.'
---

A shared remote cache has two jobs that pull against each other. A
pull request should reuse everything `main` built, or CI is slow. And
nothing a pull request builds should ever be replayed on `main`, or one
non-hermetic build (or one hostile one) poisons every run after it.

Until now vx solved this on the client: a branch's run derived a second
key per task from its branch scope and asked for either the plain key or
the scoped one. It worked, but it put the decision in the wrong place.
The client chose where to write, so only the client's honesty kept a
branch out of `main`'s entries. vx now keeps task keys plain and leaves
both decisions to the server.

## The token decides writes, always

**The OIDC token, checked against the server's OIDC trust policy, is
the only thing that decides where a write may land.** A token that
matches a trust rule writes the trusted cache. Any other token from the
repository writes only its own branch's cache. A missing token, or one
from a repository no rule names, writes nothing. No header, key or
client option can change that.

GitHub Actions and GitLab CI both mint a signed token per job that
names the repository, the ref and the workflow. That is a fact the
server can check, which a header or a key never is. So the server does
not have to trust the client at all.

## The header steers reads

What the client still knows best is which branches a read should see.
A pull request from `feat-x` wants its own earlier results first, then
`main`'s. `turboCache()` names those refs on every read, own branch
first, in one header:

```http
HEAD /v8/artifacts/0a1b2c3d4e5f6789
x-artifact-read-scopes: refs/heads/feat-x, refs/heads/main
```

The server walks the list and returns the first hit. The key is the
same on every branch, so a hit on `main`'s entry is the same bytes a
`feat-x` run would have built from the same inputs. A server that does
not know the header ignores it and keeps one shared cache, so nothing
breaks on a plain Turbo server.

CI's refs come from its env: `GITHUB_HEAD_REF` or `GITHUB_REF`, then
`GITHUB_BASE_REF` on Actions; `CI_COMMIT_REF_NAME`, then
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME` on GitLab. A merge queue reads its
base branch. On a laptop they come from git alone: the current branch,
then the default one (`origin/HEAD`). No API call, no PR lookup. That
works because a PR run writes to its head branch, so `git checkout
feat-x` on a laptop asks for exactly what CI stored for `feat-x`.

## Two client modes

| `scope` | Key | Read request | For |
| --- | --- | --- | --- |
| `'header'` (default) | `hash(inputs)` | plain key + `x-artifact-read-scopes` | servers that implement the rules below |
| `'key'` | `hash(inputs + ref)` | one batch with each ref's key, first hit wins | servers that ignore the header (Vercel) |

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [turboCache({ scope: 'key' })], // a server that ignores the header
})
```

`'key'` gives a header-blind server separate branch entries: a run
writes under its own ref's key and asks every ref's key in one batch.
That is isolation, not security: any writer can compute `main`'s key,
and that server checks nothing. Only a server can enforce, so
`'header'` is the default. `nxCache()` sends plain requests: the Nx cache spec has no
batch query, so a list of keys would cost one request per ref.

## Building the server half

Everything below is the Turbo artifacts API (`/v8/artifacts`) plus one
header. A cache server can implement it in an afternoon.

### Server config

The user sets a trust policy per team. A rule names token claims; each
value is an exact string, a glob, or a list. A token matches a rule when
every claim in it matches.

```ts
export default {
  trust: [
    // GitHub: main and merge queue, only from the main-branch workflow
    {
      iss: 'https://token.actions.githubusercontent.com',
      repository_id: '123456789',
      event_name: ['push', 'merge_group'], // pull_request_target and issue_comment run PR code with ref=main
      ref: ['refs/heads/main', 'refs/heads/gh-readonly-queue/main/*'],
      ref_protected: 'true', // an unprotected branch can be pushed with unreviewed code
      job_workflow_ref: 'org/repo/.github/workflows/ci.yml@refs/heads/main',
    },
    // GitLab: protected main, on our own runners
    {
      iss: 'https://gitlab.com',
      project_id: '4567',
      ref_path: 'refs/heads/main',
      ref_protected: 'true',
      pipeline_source: ['push', 'schedule'], // a manual pipeline can inject CI variables
      runner_environment: 'self-hosted',
    },
  ],
}
```

Pin `repository_id` or `project_id`, not the name: a re-created
repository can take an old name, never an old id. Trusted is `main`
and its merge queue only: anyone who can push can tag any commit, so a
tag's run writes to its own scope, as a branch does.

### Write scope

Built into the server, not configurable. A token that matches no rule
writes to:

- **GitHub:** `refs/heads/<head_ref>` on a PR run, otherwise `ref`. A PR
  run writes to its head branch, so a laptop finds it from git alone.
- **GitLab:** `ref_path`.

### Rules

1. **Auth.** Accept GitHub and GitLab OIDC tokens as `Authorization:
   Bearer`, and verify the signature (the issuer's JWKS), `iss`, `aud`
   and `exp`. Every read needs a token. Each developer creates their own
   read-only token, and a shared read-only token may serve other CIs;
   neither ever writes.
2. **Audience.** `aud` must be this server's own, so a token minted for
   another service can't be replayed here.
3. **Trust match.** As above: every claim a rule names must match.
4. **Write** (`PUT /v8/artifacts/:hash`). A token that matches a rule
   stores to trusted. Any other token stores to its write scope. A token
   from a repository or project no rule names writes nothing. Entries
   are immutable.
5. **Read** (`GET` and `HEAD /v8/artifacts/:hash`, and the batch
   `POST /v8/artifacts`). For each ref in the header, in order: if it
   matches a rule's ref glob, look in trusted; otherwise look in that
   ref's scope. Return the first hit.
6. **No header.** Read from trusted only, so plain Turbo clients keep
   working.
7. **Per repository.** Every scope, trusted included, lives in that
   repository's own bucket, taken from the token (`repository_id`,
   `project_id`, or the read token's repository). One team's repositories
   never share a branch.
8. **Header limits.** Each entry must be a `refs/...` string; dedupe the
   list and cap it at 8 refs. vx sends at most 8.
9. **Merge queue.** It writes to trusted before its code lands, so a
   queued PR that drops out leaves trusted entries behind. That is
   accepted: queue code is approved code.

### GitHub

| Run | Token holds | `x-artifact-read-scopes` | Server reads (first hit) | Server writes |
| --- | --- | --- | --- | --- |
| main push | `ref=refs/heads/main` | `refs/heads/main` | trusted | trusted |
| merge queue | `ref=refs/heads/gh-readonly-queue/main/…` | `refs/heads/gh-readonly-queue/main/…, refs/heads/main` | trusted | trusted |
| PR #12 (feature→main) | `ref=refs/pull/12/merge`, `head_ref=feature`, `base_ref=main` | `refs/heads/feature, refs/heads/main` | feature, trusted | `refs/heads/feature` |
| branch push | `ref=refs/heads/feature` | `refs/heads/feature, refs/heads/main` | feature, trusted | `refs/heads/feature` |
| fork PR | no token | `refs/heads/<head>, refs/heads/main` | head, trusted | nothing |
| local on main | personal token (read-only) | `refs/heads/main` | trusted | nothing |
| local on feature | personal token (read-only) | `refs/heads/feature, refs/heads/main` | feature, trusted | nothing |

### GitLab

| Run | Token holds | `x-artifact-read-scopes` | Server reads (first hit) | Server writes |
| --- | --- | --- | --- | --- |
| main pipeline | `ref_path=refs/heads/main` | `refs/heads/main` | trusted | trusted |
| merge train | `ref_path=refs/heads/feature` | `refs/heads/feature, refs/heads/main` | feature, trusted | nothing (client read-only) |
| MR or merged results (feature→main) | `ref_path=refs/heads/feature` | `refs/heads/feature, refs/heads/main` | feature, trusted | `refs/heads/feature` |
| branch pipeline | `ref_path=refs/heads/feature` | `refs/heads/feature, refs/heads/main` | feature, trusted | `refs/heads/feature` |
| fork MR | fork project's token | `refs/heads/feature, refs/heads/main` | feature, trusted | nothing (wrong project) |
| local on main | personal token (read-only) | `refs/heads/main` | trusted | nothing |
| local on feature | personal token (read-only) | `refs/heads/feature, refs/heads/main` | feature, trusted | nothing |

A GitLab token has no merge-train claim, so the server would store a
train's results in the source branch's scope. Those results are built
from the branch merged with main and the MRs ahead of it, so the branch
almost never reuses them. The CI knows it is a train, so turn writes off
there:

```yaml
build:
  rules:
    - if: $CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"
      variables:
        VX_CACHE_POLICY: local:rw,remote:r
    - when: on_success
```

A stacked PR (feature-b→feature) reads `feature-b, feature, main` in CI
and `feature-b, main` on a laptop.

## What changed in vx

- Task keys reach every remote plain; the old scoped task keys are gone.
- `turboCache()` gains `scope: 'header' | 'key'` and sends
  `x-artifact-read-scopes` on every read. A `PUT` names no scope.
- `nxCache()` and `turboCache()` no longer send `x-vx-cache-scope`.
- `VX_CACHE_SCOPE` and `github({ cacheScope })` now scope only what
  plugins store themselves (`ctx.cache`, run records).

The CI guide's [cache scopes and tokens](../../guides/ci/#cache-scopes-and-tokens) has the setup.
