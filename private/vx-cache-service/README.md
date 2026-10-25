# @vzn/vx-cache-service

vznjs's own cache server: [`@vzn/vx-cache-server`](../../packages/vx-cache-server)'s
worker, deployed with this repo's settings, `TRUST` included, so the
server package stays generic. It runs on Workers' free plan, with R2 and
D1.

No static token: CI jobs sign in with their OIDC token. Only `ci.yml`'s
runs of `main` write what every run reads; any other job of this
repository writes its branch's scope (`wrangler.jsonc`).

Workers Builds deploys it on each push to `main` that touches it:

- Root directory: `private/vx-cache-service`
- Build command: `bun install --frozen-lockfile`
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-cache-server/*`, `private/vx-cache-service/*`, `bun.lock`

The first deploy makes the D1 database and the R2 bucket, both
`vx-cache`, when they do not exist.
