# Workstream YC — Nx/Turbo parity (2026-10-07)

- **YC-1.** nx(): a `{workspaceRoot}` input glob on the root project mapped to a project glob, which stops at the root's own files; Nx globs every file. TanStack Query's `test:sherif` (`{workspaceRoot}/**/package.json`) kept its key when a package's manifest changed. Now a `workspaceFiles` glob. Rows: tests/nx-helpers-sweep.test.ts › "is a workspace glob; a {projectRoot} one stays the project's".
