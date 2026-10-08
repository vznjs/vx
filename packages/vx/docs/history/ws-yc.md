# Workstream YC — Nx/Turbo parity (2026-10-07)

- **YC-4.** vx-migrate: an input named twice (TanStack Query's `test:eslint`: `eslint.config.js` from `sharedGlobals` and its own) was written twice. `withoutTakenBack` keeps each entry once. Rows: tests/taken-back-literal.test.ts › withoutTakenBack (two repeat rows).
- **YC-2.** nx(): a serial run-commands line that opens with `nx <target> <project>` ran Nx inside the task (ngrx: 12 `build` targets run `nx build-package <project>`), a todo each in the migration. Now a `dependsOn` edge to that target, the call out of the line. Rows: tests/nx-call-edge.test.ts › "is a dependency edge; one Nx runs beside, after, or with options stays".
