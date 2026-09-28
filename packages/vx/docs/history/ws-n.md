# Workstream N — adoption paths (plan-2026-09-27)

New adoption paths in `packages/vx-migrate/src/<tool>/`, beside G's
`turbo/` and `nx/`.

## Items

N-1. `moon()` and `vx-migrate --from moon`. moon 1 and moon 2 workspaces
run under vx from `.moon/` and each `moon.yml`; the CLI writes the same
tasks as configs. Checked against `moon query tasks`: 0 differences on
moonrepo/examples (moon 1.41.7, 12 projects, 76 tasks) and on a moon 2
fixture (2.5.5) covering `inheritedBy`, merges, `rename`, `extends`,
`noop` and `moon.yml` `dependsOn`. Two rules the probe taught: moon
applies the merge strategy of the task's FINAL options to every layer
(a project's `mergeArgs: prepend` puts its args ahead of all inherited
args), and a command list's tail joins the layer's args. moonrepo/moon
itself needs toolchain plugins from GHCR, unreachable here.

- Rows: `tests/moon.test.ts` (each red with its rule removed: the `**/*`
  default, the `dependsOn` edges, final-option merges, the `.env` probe).

## Candidates not built (2026-09-28)

- Lerna without Nx: `lerna run <s>` (lerna 10.0.1, `prepNxOptions`)
  runs each package's script with an edge to its dependencies' `<s>`
  and caches nothing unless `nx.json` configures targets, which is an
  Nx repo (`nx()`). Real users (docusaurus `useNx: false`, jest via
  lerna-lite) run lerna for versioning and `lerna run build`; `vx init`
  already writes those scripts with `^build`. No `lerna()`: it would add
  only `^<s>` on non-build scripts.
- Rush: rushstack (197 projects) has no root `package.json` and no
  `pnpm-workspace.yaml`; its projects live in `rush.json`. vx discovery
  finds no workspace, and a plugin cannot add projects (the `project`
  stage fills discovered ones). Blocked on a discovery seam.

## Leads for other streams

- G: `DOTENV_PROBE` is now in `turbo/turbo-map.ts` and
  `moon/moon-map.ts`; move it to a shared module (N may not edit
  `turbo/`).
- D / coordinator: a discovery seam (a plugin names project dirs). It
  unblocks Rush (`rush.json`), Lerna's `lerna.json` `packages` without
  package-manager workspaces, and moon projects with no `package.json`.
- D: `vx init` on docusaurus leaves `build:watch` (`tsc --build --watch`)
  and `copy:watch` (`… --watch`) non-persistent; a `--watch` script is
  a watcher.
