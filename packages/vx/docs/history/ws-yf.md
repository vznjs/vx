# Workstream YF — Nx/Turbo parity (2026-10-07)

- **YF-1.** A task got no `COREPACK_HOME` or `PNPM_HOME` (Turbo and Vite Task pass both): a corepack shim fetched its manager again, and fails offline or sandboxed. Both are machine paths, as `HOME` is, so they join `ESSENTIAL_ENV`, unkeyed. Rows: tests/env.test.ts › "passes the package managers' home directories, not their other settings".
