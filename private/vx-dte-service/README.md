# @vzn/vx-dte-service

vznjs's own relay: [`@vzn/vx-dte-server`](../../packages/vx-dte-server)'s worker,
deployed with this repo's settings, `ALLOW` included, so the relay package
stays generic.

The Worker is named `vx-dte` (`wrangler.jsonc`), so its URL,
`https://vx-dte.exelord.workers.dev`, is the one `dte({ relay })` names.

Workers Builds deploys it on each push to `main` that touches the relay:

- Root directory: `private/vx-dte-service`
- Build command: `bun install --frozen-lockfile`
- Deploy command: `bunx wrangler deploy`
- Watch paths: `packages/vx-dte-server/*`, `private/vx-dte-service/*`, `bun.lock`
- Non-production branches: on, preview command `bunx wrangler preview`

A pull request that touches those paths gets a Preview of its commit, and
its DTE run uses it (`private/vx-servers/worker-url.ts`, a CI step): the PR's client and the
deployed relay may speak different protocols. A push that changes no
watched path gets no build; its run uses the newest Preview of the same
relay code. A push to main that changes the relay waits for its deploy.
`wrangler.jsonc`'s
`previews` block repeats `ALLOW` and the binding, since a Preview inherits
neither. Other PRs keep the deployed relay.
