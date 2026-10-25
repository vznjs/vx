# @vzn/vx-cache-service

vznjs's own cache server: [`@vzn/vx-cache-server`](../../packages/vx-cache-server)'s
worker, deployed with this repo's settings, `TRUST` included, so the
server package stays generic. It runs on Workers' free plan, with R2
alone.

No static token: CI jobs sign in with their OIDC token. Only `ci.yml`'s
runs of `main` write what every run reads; any other job of this
repository writes its branch's scope (`wrangler.jsonc`).

Workers Builds deploys it on each push to `main` that touches it:

- Root directory: `private/vx-cache-service`
- Build command: none (Workers Builds installs the dependencies)
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-cache-server/*`, `private/vx-cache-service/*`, `bun.lock`

The first deploy makes the R2 bucket `vx-cache` when it does not exist.
Its lifecycle rules expire `trusted/` after 30 days and `branch/` after 7.
