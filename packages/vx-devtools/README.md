# @vzn/vx-devtools

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Code vx's servers and plugins share. Core never imports it.

## Purpose

This package checks the CI tokens vx's servers take.

- `@vzn/vx-cache-server`, `@vzn/vx-history-server` and
  `@vzn/vx-dte-server` take one kind of token: a CI job's OIDC token
  (GitHub Actions, GitLab CI).
- This package is the check all three share. `@vzn/vx-dte` checks its
  workers' tokens with it too.
- It imports only jose, so a server on Workers bundles it alone.
- Clients never import it: each plugin asks its CI for its own token.
- The token alone decides what a request reads and where it writes,
  never a header or a client option.

## API

For example, a server reads `ALLOW` once and checks each request:

```ts
const authorize = oidcAuth({
  allow: parseAllow(process.env.ALLOW ?? ''),
  audience: 'https://cache.example.com',
})
const access = await authorize(req)
```

- `parseAllow(list)` reads `ALLOW` into `Allowed`s.
  - `ALLOW` is space-separated `issuer:owner/repo:workflow` entries, the
    string the DTE relay reads.
- `oidcAuth(options)` is the `Authorize` checking a request's CI token
  against them. Its options are an `OidcOptions`.
  - It answers the request's `Access`.
  - Or it throws a `Refusal`: a `status` and what to fix.
- `oidcTokenAuth(options)` is the check for a server whose requests name
  their repository plainly, in the body (`@vzn/vx-history-server`).
  - It is called as `(req, named?)`, `named` a `Repo`, and answers the
    token's `Access`.
  - It refuses a token of another repository than `named`.
  - With no token where `readAccess` is `public`, it answers `named` when
    `ALLOW` names it, or `undefined` when none is named.
- `oidcClaims(options)` is that one check, for any audience.
  - `(token, audience)` answers a `Verified`, `{ iss, claims }`, or
    throws a `Refusal`.
  - Its `allow` takes `Admits`: `ALLOW` entries whose unset `repository`
    or `workflow` admits any.
  - A check that binds the repository by a claim of its own names the
    issuer alone.
- `errorJson(status, message)` is every server's refusal,
  `{ code, message }`.
- `notAllowed(allow)` is its `405`, naming the methods in `Allow`.
- `hashPart(text)` is what a request names its issuer and repository by
  (`vx-issuer`, `vx-repository`).
  - It is the first 128 bits of its SHA-256 in hex. It uses Web Crypto,
    so Bun and Workers agree.
  - A server stores them plain: a cache object's name and a history row
    hold the issuer, repository and ref.
- `statusLine(tone, name, text)` is the line a server prints when it
  starts (`'ok'`) or refuses to (`'err'`).
  - For example: `✓ vx-cache-server  listening on …`.
  - It is painted as vx's own status lines: `NO_COLOR`, then
    `FORCE_COLOR`, then a terminal whose `TERM` is not `dumb`.
  - Any lines after the first are dim.

```ts
export class Refusal extends Error {
  readonly status: number
}
export function errorJson(status: number, message: string): Response
export function notAllowed(allow: string): Response
export interface Allowed {
  readonly issuer: string
  readonly repository: string
  readonly workflow: string
}
export interface Access {
  readonly issuer: string
  readonly repository: string
  readonly write?: string
}
export type Authorize = (req: Request) => Promise<Access>
export interface OidcOptions {
  readonly allow: readonly Allowed[]
  readonly audience?: string
  readonly fetchJson?: (url: string, fresh: boolean) => Promise<unknown>
  readonly now?: () => number
  readonly readAccess?: string
}
export function parseAllow(list: string): Allowed[]
export interface Admits {
  readonly issuer: string
  readonly repository?: string | undefined
  readonly workflow?: string | undefined
}
export interface Verified {
  readonly iss: string
  readonly claims: Readonly<Record<string, unknown>>
}
export function oidcClaims(
  opts: Pick<OidcOptions, 'fetchJson' | 'now'> & { readonly allow: readonly Admits[] },
): (token: string, audience: string) => Promise<Verified>
export function oidcAuth(opts: OidcOptions): Authorize
export interface Repo {
  readonly issuer: string
  readonly repository: string
}
export function oidcTokenAuth(
  opts: OidcOptions,
): (req: Request, named?: Repo) => Promise<Access | undefined>
export interface KeysCache {
  match(url: string): Promise<Response | undefined>
  put(url: string, res: Response): Promise<void>
}
export function cachedFetchJson(
  cache: KeysCache,
  fetchImpl?: typeof fetch,
): (url: string, fresh: boolean) => Promise<unknown>
```

- `fetchJson`'s `fresh` is true for a reload of keys already read. A reload
  must reach the issuer. The first read of a URL may come from a cache.
- `cachedFetchJson(caches.default)` (any `KeysCache`) is how a Worker reads the keys: a fresh
  isolate takes them from the cache its data center shares (10 minutes),
  not from the issuer.

## How it decides

A token passes only when every rule below holds.

For example, where
`ALLOW` names `https://token.actions.githubusercontent.com:acme/app:ci.yml`,
a job of `acme/app`'s `ci.yml` passes the repository and workflow rules.

- A token whose header is not `RS256`, or with no signature a 2048-bit
  key could make, is `401` before any read of its issuer's keys.
- jose checks the JWT: `RS256`, and the signature against the issuer's
  keys.
- It also checks `aud`, the audience with or without a trailing slash,
  and `exp` and `nbf` within 60 s.
- The issuer's keys are found through its
  `/.well-known/openid-configuration` and kept 10 minutes.
- They are read again for a key they lack, at most every 30 s. Keys a
  cache may have answered (a Worker's first read) are read again at once.
- With `oidcAuth`, every request names its repository: `vx-issuer` and
  `vx-repository`. One missing or not a hash is `400`.
  - They are the `hashPart`s of the issuer's URL (no trailing slash) and
    of its `org/name` lowercased.
- The token's repository is its issuer and its name, `org/name`
  lowercased.
  - The name is `repository` (GitHub) or `project_path` (GitLab), what a
    checkout's origin names.
  - A trailing slash, in `ALLOW` or the token, is the same issuer.
- A repository `ALLOW` does not name is `403`, and so is one other than
  the request names.
- The token's workflow must be one an entry names for that repository:
  any other is `403`.
  - The workflow is `job_workflow_ref` on GitHub, `ci_config_ref_uri` on
    GitLab, up to its last `@`, before the ref or SHA.
  - Its repository part matches in any case; its file name only in its
    own case, as git keeps it: `CI.yml` is not `ci.yml`.
- With `readAccess: 'public'` (`READ_ACCESS`), a request with no token
  reads the repository it names when `ALLOW` names it, else `403`.
  - It writes nothing.
  - Any other value than `public` or unset throws.
- A token writes its `ref` (GitLab's `ref_path`).

<details>
<summary>Details: key reads that fail</summary>

- A read that times out, drops, or answers 5xx or 429 is tried again:
  three tries in 15 s at most, 4 s each.
- When a refetch fails, the keys last read still check tokens.
- A key they lack is then `502`, not a refused token.

</details>

<details>
<summary>Details: which ref a run writes</summary>

- A `pull_request` run writes its merge ref, `refs/pull/<n>/merge`,
  never its `head_ref`, which a fork names.
- A `merge_group` run writes its base branch for a
  `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>` ref.
- A `pull_request_target`, `issue_comment` or `workflow_run` run writes
  nothing: its `ref` is the base while it may run a pull request's code.
- Nor does a GitLab run whose `source_project_path` or
  `job_project_path` names another project.
  - That is a fork's merge request, or a child pipeline of one.
- Nor does a merge request pipeline naming no source project (GitLab
  before 19.5).

</details>
