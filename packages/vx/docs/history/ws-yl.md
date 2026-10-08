# Workstream YL — Nx/Turbo parity (2026-10-07)

- **YL-1.** An Nx input inside the project's own outputs (TanStack/table's `{projectRoot}/dist`, 35 todos) was dropped with a todo claiming Nx hashes it from disk. Probed on Nx 23.3: its file map skips gitignored files, and a changed `dist` file was a cache hit for both an own input and a `^public` one. Dropped silently now. Rows: packages/vx-migrate/tests/nx-upstream.test.ts › "is dropped from a dependency’s twin, as Nx hashes nothing there", "is dropped from the task’s own inputs; a sibling path stays".
