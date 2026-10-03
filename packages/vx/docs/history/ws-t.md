# Workstream T — the Nx and Turbo asks (2026-10-03)

The owner's ask: build the top requests from Nx and Turbo issues that vx
lacked (research in the project thread, 2026-10-03).

- **T-1.** Cache scopes (owner: "trusted and untrusted cache… scoped per
  PR"; CREEP, CVE-2025-36852; Nx discussion #28332). `cacheScope` in
  `vx.workspace.ts`: `'trusted'` (default) reads and writes the task
  keys, `'read-only'` writes nothing (the CLI's default off CI, owner), any
  other name reads its own key, then the trusted one (owner: "nested
  lookup first from pr scope"; a batch probe that found only the trusted
  key skips the scope's GET), and writes its own only (`ScopedRemote` in
  `layered-cache.ts`, a key `xxh3(scope, task key)` so every wire stores
  it unchanged). `github()` sets it from the ref on Actions: the default
  branch trusted, `pr-<n>`, `ref-<name>`, and an unknown default branch
  untrusted. The owner's caveat stands in security.md: a client-side
  convention, not a boundary; the server must scope writes by token.
  Rows: `cache-scope.test.ts` (core: scoped writes, own-scope reads,
  own-scope-first, one GET per hit, read-only, the CLI default) and vx-github's `cache-scope.test.ts`, each
  red without its half.
