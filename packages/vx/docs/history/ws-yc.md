# Workstream YC — Nx/Turbo parity (2026-10-07)

- **YC-3.** vx-migrate (nx): nx.json's `parallel`, `defaultBase` and `maxCacheSize` were notes to add to the `vx.workspace.ts` vx-migrate itself writes. Now written into it as `concurrency`, `affectedBase`, `cacheRetention.maxSize`; a note only where a workspace file exists. Rows: tests/migrate-nx-workspace.test.ts › "writes them into the vx.workspace.ts it writes, and says nothing of them", "names them where the workspace file is already there".
