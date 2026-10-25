# The vx cache server (`@vzn/vx-cache-server`), 2026-10

A server anyone hosts that keeps vx's artifacts, so a fresh CI runner or
a new branch starts warm. It is optional: a workspace that declares no
plugin for it never talks to it, and Turbo-wire, Nx-wire and REAPI
remotes stay. Each item below is marked shipped or planned, and this
page changes in the same PR as the item it describes.

## Shape

- Shipped: one fetch handler (`src/server.ts`) over one seam, `Blobs`,
  so every backend shares every route: Bun with an S3-compatible bucket
  (Bun's S3 client), the same server as a Docker image, and Workers with
  R2. One conformance suite (`tests/conformance.ts`) runs against each;
  the Worker runs in workerd (miniflare), the image in Docker, and the
  bucket is an in-memory S3 that Bun's own client talks to.
- Shipped: no database (M, 2026-10-25). An artifact is one object named
  `<issuer>/<id>/<scope>/<hash>`, the first three each hashed (M,
  2026-10-25: nothing else, no tier); its size is
  the bucket's metadata, and a put replaces a name whole, so racing
  uploads keep one whole artifact and nodes share nothing but the bucket.
  Expiry is one bucket lifecycle rule by age; the server sweeps nothing,
  and no prefix tells main from a branch.
- Shipped: every read names exact scopes (M, 2026-10-25: the whole
  point of scope is exact keys) on Turbo's routes (M, 2026-10-25: "use
  turbo"): `GET`, `HEAD` and `PUT /v1/artifacts/<hash>`, a download's
  scope in `x-artifact-scope`, and `POST /v1/artifacts` with `{ hashes,
scopes }` (M: "checks can ask many scopes"), up to `maxCheckHashes`
  lookups, answering each hash's `{ size, scope }`, the first scope
  asked that holds it, or null. One exact head per lookup: a list of a
  scope reads every name in it, and a scope may hold billions (M). A
  Worker checks 6 by default, one round of its waiting calls, and the
  client sends chunks at once.
- Shipped: limits an operator sets (`MAX_CHECK_HASHES`,
  `MAX_UPLOAD_BYTES`), named on every check and
  at `/v1/capabilities`; the server never lowers them to a plan's (M,
  2026-10-25: never optimize for the free plan).
- Shipped: Turbo's shape where it fits (M, 2026-10-25: keep to the
  standard, differ only where it blocks us): `{ code, message }` errors,
  hex hashes, our own `/v1`. Batches and exact scoped keys are ours:
  Turbo has neither.
- Shipped: task timings left for `@vzn/vx-history-server` (M,
  2026-10-25): this server keeps artifacts only.

## Encryption (planned, no format change)

- The server compares hashes and never reads them or the bytes
  (PROTOCOL.md § Opaque strings). End-to-end encryption is then the
  client's alone: a workspace key the server never sees, an HMAC of each
  hash (equality still works, so lookups do), and an authenticated
  cipher over each artifact's bytes.
- Refs stay plain: the server matches them against CI tokens, which name
  them.

## Access

- Shipped: CI OIDC tokens only (`@vzn/vx-devtools`, shared with vx's other
  servers): a token writes its own branch's scope; a ref a `TRUST` rule
  names is protected, written only by a token matching the rule; another
  repository gets nothing.

## Next

- Shipped: `vxCache()` (`@vzn/vx-cache`), the client plugin: a remote for
  core's cache seam that asks for the run's refs' exact keys, its branch
  then main's.
- Planned: a storage cap, by a daily list of the bucket.
