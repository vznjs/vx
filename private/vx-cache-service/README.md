# @vzn/vx-cache-service

vznjs's own cache server: [`@vzn/vx-cache-server`](../../packages/vx-cache-server)'s
worker, deployed with this repo's settings, `TRUST` included, so the
server package stays generic. It runs on Workers' free plan, with R2
alone.

No static token: CI jobs sign in with their OIDC token. Only `ci.yml`'s
runs of `main` write `main`'s scope, which every run reads after its own;
any other job of this repository writes its branch's scope (`wrangler.jsonc`).

Workers Builds deploys it on each push to `main` that touches it:

- Root directory: `private/vx-cache-service`
- Build command: none (Workers Builds installs the dependencies)
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-cache-server/*`, `private/vx-cache-service/*`, `bun.lock`

The R2 bucket is `vx-cache-enam`, made with the `enam` location hint (M,
2026-10-25): our runners reach Cloudflare across the US, most from the
east and centre. A bucket's location is fixed when it is made.
One lifecycle rule expires every object 7 days after its upload: names are
hashed, so no prefix tells `main` from a branch (M, 2026-10-25).
