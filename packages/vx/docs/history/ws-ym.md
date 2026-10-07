# Workstream YM — Nx/Turbo parity (2026-10-07)

- **YM-4.** `bunx @vzn/vx-migrate` in a fresh Nx clone (push-based/user-flow)
  failed with the `nx()` plugin's advice ("pass it as graph: '<path>'"),
  an option the CLI does not take, then a second export hint. It now
  says nx is not installed and names `<manager> install`. Rows:
  `migrate.test.ts` › "--from turbo with no turbo.json, and --from nx
  with no Nx at all, say which is missing", "nx.json without the graph
  file or nx tells the user to install".
