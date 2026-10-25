# @vzn/vx-dte-relay-worker

vznjs's own relay: [`@vzn/vx-dte-server`](../../packages/vx-dte-server)'s worker,
deployed with this repo's settings, `ALLOW` included, so the relay package
stays generic.

Workers Builds deploys it on each push to `main` that touches the relay:

- Root directory: `private/vx-dte-relay-worker`
- Build command: `bun install --frozen-lockfile`
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-dte-server/*`, `private/vx-dte-relay-worker/*`, `bun.lock`
- Non-production branches: on, preview command `bunx wrangler preview`

A pull request that touches those paths gets a Preview of its commit, and
its DTE run uses it (`preview.ts`, a CI step): the PR's client and the
deployed relay may speak different protocols. A push that changes no
watched path gets no build; its run uses the newest Preview of the same
relay code. A push to main that changes the relay waits for its deploy.
`wrangler.jsonc`'s
`previews` block repeats `ALLOW` and the binding, since a Preview inherits
neither. Other PRs keep the deployed relay.
