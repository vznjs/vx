# @vzn/vx-dte-relay-deploy

vznjs's own relay: [`@vzn/vx-dte-relay`](../../packages/vx-dte-relay)'s worker,
deployed with this repo's settings, `ALLOW` included, so the relay package
stays generic.

Workers Builds deploys it on each push to `main` that touches the relay:

- Root directory: `private/vx-dte-relay-deploy`
- Build command: `bun install --frozen-lockfile`
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-dte-relay/*`, `private/vx-dte-relay-deploy/*`, `bun.lock`
