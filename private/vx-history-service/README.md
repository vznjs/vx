# @vzn/vx-history-service

vznjs's own history server: [`@vzn/vx-history-server`](../../packages/vx-history-server)'s
worker, deployed with this repo's settings, `TRUST` included, so the
server package stays generic. It runs on Workers' free plan, with D1
(`vx-history`).

No static token: CI jobs sign in with their OIDC token. Only `ci.yml`'s
runs of `main` write `main`'s rows; any other job of this repository
writes its branch's (`wrangler.jsonc`).

Workers Builds deploys it on each push to `main` that touches it:

- Root directory: `private/vx-history-service`
- Build command: none (Workers Builds installs the dependencies)
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-history-server/*`, `packages/vx-devtools/*`, `private/vx-history-service/*`, `bun.lock`

Rows not reported for 30 days are deleted by the server itself.
