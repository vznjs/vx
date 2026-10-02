# Workstream P2 — the Nx migrator (`bunx @vzn/vx-migrate` on an Nx repo → native vx config)

## Items

- **P2-1** The migrator writes an executor target as the command its
  executor runs (`src/nx/nx-native.ts`: `@nx/jest:jest`,
  `@nx/vitest:test` / `@nx/vite:test`, `@nx/vite:build`,
  `@nx/eslint:lint`, `@nx/js:tsc`, `@nx/playwright:playwright`, and their
  `@nrwl/` names), from where Nx ran the tool and with the schema
  defaults Nx applies; what the executor did besides (a type-check, a
  `package.json` or `assets` in the output) is a TODO. Any other executor
  is a placeholder that fails naming it and its options, one TODO per
  executor. It wrote an `nx-exec` line, so a migrated repo still needed
  Nx installed to run. `nx()` keeps `nx-exec`.
- **P2-2** The migrator writes `@nx/vite:dev-server` as `vite` and
  `@nx/vite:preview-server` as `vite preview` on the `buildTarget`'s config
  file, mode and output dir (a configuration's own `buildTarget` read in
  that configuration), and `@nx/storybook:storybook` / `:build` as
  `storybook dev` (on Nx's port 9009) / `storybook build` from the
  workspace root. Each was a failing placeholder.

## Leads for other streams
