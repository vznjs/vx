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
- **P2-3** The migrator writes `@nx/next:build` as `next build` with
  `NX_NEXT_OUTPUT_PATH` set, `@nx/next:server` as `next dev` / `next
start` (in the build output) with Nx's port and `PORT`, and
  `@nx/cypress:cypress` as `cypress run` / `open` from the workspace root
  on the config file's directory; the dev server Nx started first, and
  the files `next build` did not write, are TODOs. Each was a failing
  placeholder.
- **P2-4** An executor the migrator has no command for, from a plugin
  that ships `convert-to-inferred` (`@nx/webpack`, `@nx/rollup`, …),
  names that generator in its TODO: those executors feed their options
  to the project's config function, so no flag line reproduces them, and
  Nx's generator moves them into the config.
- **P2-5** The migrator writes `@nx/esbuild:esbuild` (bundled, its
  default) as esbuild's own CLI from the workspace root: one build per
  format, `--packages=external` for the npm dependencies Nx externalizes
  without `thirdParty`, the output emptied first; the type-check, the
  `package.json` and assets Nx added are TODOs. It was a failing
  placeholder.

## Leads for other streams
