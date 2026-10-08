# Workstream YM — Nx/Turbo parity (2026-10-07)

- **YM-4.** `bunx @vzn/vx-migrate` in a fresh Nx clone (push-based/user-flow)
  failed with the `nx()` plugin's advice ("pass it as graph: '<path>'"),
  an option the CLI does not take, then a second export hint. It now
  says nx is not installed and names `<manager> install`. Rows:
  `migrate.test.ts` › "--from turbo with no turbo.json, and --from nx
  with no Nx at all, say which is missing", "nx.json without the graph
  file or nx tells the user to install".
- **YM-3.** An Nx migration wrote `vx.workspace.ts` and still told the
  user to add nx.json's `defaultBase` (and `parallel`, `maxCacheSize`)
  to it (nartc/mapper). The file it writes now carries `affectedBase`,
  `concurrency` and `cacheRetention`; a note stays only beside a file
  already there or for a size vx cannot read. Rows:
  `migrate-nx-workspace.test.ts` › "writes them into the vx.workspace.ts
  it writes; one it cannot read stays a note".
- **YM-1.** An output naming one committed file (hono/middleware's lint
  declares `eslint-suppressions.json`) gave every reader beside it a `!`
  that hid a source, so all 45 builds and typechecks ran uncached. The
  entry and the readers' `!` are now dropped; the readers keep their
  cache (45 no-cache → 44 hits warm). Rows: `tracked-outputs.test.ts` ›
  "drops the entry and the `!` readers got for it; readers stay cached".
