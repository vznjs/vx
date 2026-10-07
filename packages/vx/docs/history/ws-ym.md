# Workstream YM — Nx/Turbo parity (2026-10-07)

- **YM-3.** An Nx migration wrote `vx.workspace.ts` and still told the
  user to add nx.json's `defaultBase` (and `parallel`, `maxCacheSize`)
  to it (nartc/mapper). The file it writes now carries `affectedBase`,
  `concurrency` and `cacheRetention`; a note stays only beside a file
  already there or for a size vx cannot read. Rows:
  `migrate-nx-workspace.test.ts` › "writes them into the vx.workspace.ts
  it writes; one it cannot read stays a note".
