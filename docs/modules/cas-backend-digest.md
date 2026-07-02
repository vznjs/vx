# `src/cache/cas-backend.ts` + `digest.ts` — pluggable CAS (internal)

## Purpose

`Digest { hash, sizeBytes }` as a first-class content address, and
`CASBackend` separating "where bytes live" from the SQL entries index —
the seam a future serve-hosted artifact store / S3 / R2 backend drops
into (dev-flows roadmap Phase 3).

## Status

**Internal, not exported from the package façade** (removed 2026-07 —
no production consumer yet; the modules + unit tests stay as the
artifact-store foundation). `FsCASBackend` and `MemoryCASBackend` are
the reference implementations; `Cache.contentBackend()` exposes the
local store's view.
