---
title: Setup generator
description: Generate a complete, ready-to-run vx-cloud docker-compose.yml — secret included, nothing to fill in by hand.
---

Pick a mode, copy the file, run one command. The session secret is generated
**in your browser** with `crypto.getRandomValues` and never leaves it — this
page is static and has no backend to send it to.

<div id="vx-setup"></div>

## What happens next

1. `docker compose up` — the app waits for Postgres and the bucket, then binds
   `:4321`.
2. Open <http://localhost:4321> and **register**. The first account becomes the
   instance admin, and signup then closes; invite everyone else from Admin.
3. Admin → Tokens → mint a **CI token**, then point a workspace at it:

   ```sh
   export VX_CLOUD_URL=http://localhost:4321
   export VX_CLOUD_TOKEN=vxc_…
   vx run build          # runs land in the dashboard
   ```

That is the whole setup. No config file in your repo, no key to invent.

## If JavaScript is off

The generator needs JS to produce a random secret. Without it, take the
compose file from [Self-hosting](/vx/cloud/self-hosting/) and generate the one
value yourself:

```sh
openssl rand -hex 32
```

## Going to production

Switch the generator to **Production** and it emits the same app service
pointed at your own Postgres and S3-compatible bucket (Cloudflare R2, AWS S3,
MinIO — anything that speaks the S3 API), with no `postgres`/`minio` services
of its own.

Two things to get right there:

- **`VX_CLOUD_BASE_URL` must be your real `https://` origin.** It is what
  invite links are minted against, and `https://` is what flips session
  cookies to `Secure`.
- **Run behind a TLS-terminating proxy.** See the `edge` profile in
  [Self-hosting](/vx/cloud/self-hosting/) for an HTTP/2 + HTTP/3 Caddy front
  end, which also lets one connection multiplex many concurrent cache
  requests.

The app is **stateless** — all history is in Postgres, all artifact bytes are
in the bucket — so you can scale it out behind a load balancer without any
sticky-session configuration.
