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

- `parseTrust(json)` reads `TRUST` into `TrustRule`s; `oidcAuth(options)` is the `Authorize` checking a request's CI token against
  them (its options an `OidcOptions`), answering its `Access` or throwing a `Refusal` (`status` and what
  to fix).
- `hashPart(text)` is what a server stores in place of an issuer, a repository id or a scope: the first
  128 bits of its SHA-256 in hex (Web Crypto, so Bun and Workers agree), never the plain value.

```ts
export class Refusal extends Error {
  readonly status: number
}
export interface TrustRule {
  readonly iss: string
  readonly [claim: string]: string | readonly string[]
}
export interface Access {
  readonly issuer: string
  readonly id: string
  readonly write?: string
}
export type Authorize = (req: Request) => Promise<Access>
export interface OidcOptions {
  readonly trust: readonly TrustRule[]
  readonly audience?: string
  readonly fetchJson?: (url: string) => Promise<unknown>
  readonly now?: () => number
}
export function parseTrust(json: string): TrustRule[]
export function oidcAuth(opts: OidcOptions): Authorize
```

## How it decides

- jose checks the JWT: `RS256`, the signature against the issuer's keys
  (found through its `/.well-known/openid-configuration`, kept and
  refetched by `createRemoteJWKSet`), `aud`, `exp` and `nbf` within 60 s.
- The repository is the token's issuer (`iss` without its scheme) and its
  `repository_id` (GitHub) or `project_id` (GitLab). One no rule names is
  `403`.
- A token writes its branch (a pull request's head branch on GitHub, a
  merge queue's base branch for a `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`
  ref, else `ref`; GitLab's `ref_path`). A ref a rule names is protected: a token on
  it that matches no rule reads only.
