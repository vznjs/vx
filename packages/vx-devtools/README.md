# @vzn/vx-devtools

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Code vx's servers and plugins share. Core never imports it.

## Purpose

First, the CI tokens vx's servers take. `@vzn/vx-cache-server` and
`@vzn/vx-history-server` take one kind of token: a CI job's OIDC token
(GitHub Actions, GitLab CI). This package is the check both share. It imports only jose, so a server on Workers
bundles it alone. Clients never import it: each plugin asks its CI for
its own token. The token alone decides
what a request reads and where it writes, never a header or a client
option.

## API

- `parseAllow(list)` reads `ALLOW` (space-separated `issuer:owner/repo:workflow` entries, the string the DTE relay reads) into `Allowed`s; `oidcAuth(options)` is the `Authorize` checking a request's CI token against
  them (its options an `OidcOptions`), answering its `Access` or throwing a `Refusal` (`status` and what
  to fix). `oidcTokenAuth(options)` is the check for a server whose
  requests name their repository plainly, in the body (`@vzn/vx-history-server`):
  `(req, named?)`, `named` a `Repo`, answers the token's `Access`, refusing a token of
  another repository than `named`; with no token where `readAccess` is
  `public`, `named` when ALLOW names it, or `undefined` when none is named.
- `errorJson(status, message)` is every server's refusal, `{ code, message }`
  (Turbo's spec's `Error`); `notAllowed(allow)` its `405`, naming the methods in `Allow`.
- `hashPart(text)` is what a server stores in place of an issuer, a repository name or a scope: the first
  128 bits of its SHA-256 in hex (Web Crypto, so Bun and Workers agree), never the plain value.

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
  readonly fetchJson?: (url: string) => Promise<unknown>
  readonly now?: () => number
  readonly readAccess?: string
}
export function parseAllow(list: string): Allowed[]
export function oidcAuth(opts: OidcOptions): Authorize
export interface Repo {
  readonly issuer: string
  readonly repository: string
}
export function oidcTokenAuth(
  opts: OidcOptions,
): (req: Request, named?: Repo) => Promise<Access | undefined>
```

## How it decides

- jose checks the JWT: `RS256`, the signature against the issuer's keys
  (found through its `/.well-known/openid-configuration`, kept and
  refetched by `createRemoteJWKSet`), `aud`, `exp` and `nbf` within 60 s.
- With `oidcAuth`, every request names its repository: `vx-issuer` and `vx-repository`,
  the `hashPart`s of the issuer's URL (no trailing slash) and of its
  `org/name` lowercased; one missing or not a hash is `400`.
- The token's repository is its issuer (a trailing slash, in `ALLOW` or
  the token, is the same issuer) and its name, `org/name` lowercased: `repository` (GitHub) or `project_path` (GitLab), what a
  checkout's origin names (2026-10-25). One `ALLOW` does not name is
  `403`, and so is one other than the request names.
- The token's workflow (`job_workflow_ref` on GitHub, `ci_config_ref_uri`
  on GitLab, up to its `@`) must be one an entry names for that
  repository: any other is `403`.
- With `readAccess: 'public'` (`READ_ACCESS`), a request with no token
  reads the repository it names when `ALLOW` names it (else `403`), and
  writes nothing. Any other value than `public` or unset throws.
- A token writes its branch (a `pull_request` run's head branch on GitHub;
  a `merge_group` run's base branch for a `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`
  ref, else `ref`; GitLab's `ref_path`). A `pull_request_target`,
  `issue_comment` or `workflow_run` run writes nothing: its `ref` is the
  base while it may run a pull request's code. Nor does a `pull_request`
  run whose head branch has its base branch's name.
