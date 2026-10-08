# Workstream GA — growth and adoption (2026-10-08)

- **GA-1.** A Turbo or Nx team ran two tools: `vx init` wrote a
  workspace file declaring `turbo()` / `nx()`, then `bunx
@vzn/vx-migrate` wrote the configs. `vx init` is the one command now
  (owner, 2026-10-08): beside `turbo.json` or `nx.json` it runs the
  installed `@vzn/vx-migrate`, else this vx's version through `bun x`
  (`BUN_BE_BUN=1` for the compiled binary), which asks a terminal native
  or keep. `vx init --keep` is the old workspace-file adoption, and
  vx-migrate's keep calls it so. Proven: the vx-migrate row that runs
  core's `vx init` fails with the handover reverted.
