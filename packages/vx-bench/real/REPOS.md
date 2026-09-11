# The real Turbo repos vx was benched on

Every repository `turbo-repo.sh` has been run against, with the exact
revision, toolchain, scope and every adjustment the bench made to the
repository — so the tables in `docs/benchmarks.md` can be re-run, and
so nobody mistakes a bench-side change for the plugin's own mapping.
The rule for adjustments: a change is made only when the repo's own
config cannot run here as shipped, or when it handicaps one tool for a
reason that has nothing to do with the runner; every one is named.

Box for every run below: this container — 4 cores, 16 GB of which the
session's memory cgroup allows 13.3 GiB (`memory.limit_in_bytes`; a
process over it is OOM-killed, see n8n), Linux 6.18 (Firecracker), ext4
on a virtio disk that was 92% full (its file creates alternate between
~30 µs and ~400 µs per file; the medians of three interleaved reps are
the defence). Bun 1.4.2; vx compiled from
this branch with `bun build --compile --minify --bytecode`; Turbo is
each repo's own devDependency, run through `node_modules/.bin/turbo`
with the repo's root `node_modules/.bin` on PATH (what its own
`yarn build` / `pnpm build` would give it), `--no-daemon`. Both tools
at 10 workers (Turbo's default; vx's default is the core count) unless
the repo's own script says otherwise; the wide sets at 3 (below). Full artifact cleanup before a
cold and a restore arm: every git-ignored path except `node_modules`,
`.yarn`, `.husky`, `.env*`, `.vx` and `.turbo` (the two caches, wiped
separately for a cold arm). Each arm's output is kept as
`.vx-bench-<tool>-<arm>.log` beside the repo.

## solidjs/solid — b25c557 (2026-09-10)

pnpm 9, Turbo 2.10.10, Node 22. `vx.workspace.mjs`: `turbo()` only.
Scope: the whole workspace. `build` = 4 executed tasks, `test test-types`
= 7. No adjustments. First harness (dist-only wipe, no `noop2`).

## withastro/astro — 8be33a1 (2026-09-10)

pnpm 10 (11.13 in the box), Turbo 2.10.2, Node 22.22. Scope: the
filters of the repo's own `build` script — `astro create-astro
@astrojs/* astro-vscode @benchmark/*` (553 workspace members, 32 with a
`build`). `build` = 32 tasks; wide set `build test` = 55.

- `vx.workspace.mjs`: `turbo()` only.
- **turbo.json edited, for Turbo's benefit:** `!dist/**/*` and
  `!src/**/*.prebuilt*` added to the `inputs` of `build`, `build:ci`
  and `prebuild`. As shipped, `inputs: ["**/*", …]` is an explicit
  glob, which Turbo matches against the filesystem gitignore or not, so
  each package's own outputs are in its hash: Turbo's first run after a
  restore rebuilt all 32 (59.6 s) and, 19 builds not being
  byte-reproducible, the run after that rebuilt those 19 (48.8 s, 13
  cached), forever. Probed with `--dry=json`: one byte appended to a
  gitignored `dist/index.js` changes the hash. vx excludes a task's
  declared outputs from its inputs on the same config.
- The wide set (`build test`, 55) is dropped: `test` depends on `^test`
  only and the tests import their package's `dist`, so a cold tree fails
  under both tools (three own-`dist` tests under Turbo; under vx the
  cross-package `@astrojs/language-server#test` and `@astrojs/ts-plugin#test`,
  which downloads VS Code through the proxy).
- The first harness's `dist`-directory wipe deleted a TRACKED fixture
  file, `packages/astro/e2e/fixtures/cloudflare/packages/my-lib/dist/index.js`,
  which stays deleted in the bench tree (it is an e2e fixture, outside
  every scoped task's inputs).

## payloadcms/payload — 06f05f7 (2026-09-10)

pnpm 10, Turbo 2.10.4, Node 22.22. Scope: the repo's own `build:all`
filters — `!blank !blank-tanstack !website !ecommerce` (the four
templates). `build` = 45 tasks; wide set `build lint` = 89.

- `vx.workspace.mjs`: `turbo()` only.
- No adjustments. Two things the repo taught the harness: 42
  `tsconfig.tsbuildinfo` files live in the package roots, and a wipe of
  `dist` alone made the next incremental tsc skip its declaration emit
  (TS6305 in every dependant, under either tool); and `@payloadcms/ui`
  has 535 output directories, over vx's former 256-directory snapshot
  cap.

## medusajs/medusa — 56c136f0 (2026-09-10)

yarn 3.2.1 (`nodeLinker: node-modules`, `nmMode: hardlinks-global`,
`checksumBehavior: ignore` — the lockfile's checksums did not match
the registry mirror here), Turbo 1.13.4 (a `pipeline` turbo.json),
Node 22.22. Scope: the whole workspace, `build build:plugin` with
`--concurrency=100%` for both tools, as the repo's own `build` script
runs it. 83 tasks; wide set `build build:plugin test` = 157. 24k
tracked files.

- `vx.workspace.mjs`: `turbo()` plus a ten-line project-stage plugin
  that sets `cache.outputs.files` of `build` and `build:plugin` to
  `dist/**` and `.medusa/**`, with `inputs.files: ['**/*']` and
  `inputs.workspaceFiles: ['turbo.json']` (the mapped inputs). The
  repo's turbo.json declares the outputs as `*/**` and `.medusa/**`
  minus `!src/**` and `!node_modules/**`; vx has no output negation and
  `turbo()` runs such a task uncached rather than clean `*/**`
  (the sources) before every exec. The override names what Turbo
  caches, so both tools cache the same files.
- The wide set (`build build:plugin test`, 157) is dropped: `test` has no
  `dependsOn` in turbo.json, so on a cold tree each tool runs some test
  before the package it imports is built (vx `@medusajs/auth#test`,
  Turbo `@medusajs/dashboard#test`), and the arm fails under both.
- The root `node_modules/.bin` on PATH is what lets
  `@medusajs/icons#build` find `rollup` — a root devDependency the
  package does not declare, resolved through the root `yarn build` in
  the repo's own workflow. Bare, Turbo exited 127 on it.

## n8n-io/n8n — dd86cab5 (2026-09-11)

pnpm 12.3.4, Turbo 2.9.18, **Node 24.21** (the repo requires ≥ 24; the
box has 22, so a Node 24 tarball sits in the scratchpad and both tools
run with it first on PATH). Scope: the whole workspace. `build` = 70
tasks; wide set `build typecheck lint` = 220. 84 workspace members.

- `vx.workspace.mjs`: `turbo()` only.
- **Install:** `neverBuiltDependencies: ['@vscode/ripgrep']` appended
  to `pnpm-workspace.yaml` — its postinstall downloads a binary from
  GitHub releases, which the container's egress policy refuses; the
  package is a dependency of `@n8n/computer-use` and nothing benched
  runs it. The lockfile is modified accordingly by the install.
- `@n8n/storybook` opts out of `build` and `test` with a bare
  `{ "extends": false }` per-package turbo.json; Turbo 2.9 runs nothing
  for it and, since STATUS 138, neither does vx.
- One vx cold rep read 193 s against 133–137 s for the other two and a
  standalone re-run; the disk's slow phase, absorbed by the median.
- The wide set does not fit the cgroup above 2 workers: at 4 the cold
  arm lost `n8n-editor-ui#lint` and `#typecheck` to the OOM killer
  (3.6 GB resident each, `dmesg`; the lint passed alone on the same
  inputs afterwards), and at 3 the same two with `n8n-nodes-base#lint`
  beside them (vue-tsc 5.7 GB, the two eslints 3.85 GB each) filled the
  cgroup to the byte and thrashed for 20 minutes at 97% system time
  with 211 of 220 tasks done. Dropped (owner, 2026-09-11: "leave n8n
  alone, we have plenty of repos"); n8n's numbers are the `build` set.

## calcom/cal.com — 569a389 (2026-09-09)

yarn 4.12 (node-modules linker), Turbo 2.7.1, Node 22.22. Scope:
`@calcom/web...` (the app and its dependencies): `build` = 13 tasks, of
which three are `cache: false` in turbo.json (`@calcom/prisma#build`,
`#post-install` — prisma generate — and `@calcom/web#copy-app-store-static`)
and run on every arm under both tools, ~12 s together. Wide set
`build lint` (`type-check` is `cache: false` in turbo.json), 3 workers.

- `.env` copied from `.env.example`, with `SKIP_DB_MIGRATIONS=1` added
  (no database here; `@calcom/prisma#build` connects otherwise) and the
  two empty secrets filled with placeholder strings (`NEXTAUTH_SECRET`,
  `CALENDSO_ENCRYPTION_KEY`; `next.config.ts` refuses to load without
  them). `apps/web/.env -> ../../.env`, because Next reads the app
  directory's `.env`, not the root's.
- `npm config set cafile` to the container's proxy CA:
  `@calcom/embed-core#build` runs `npx shx`, a registry fetch that
  failed TLS behind the proxy under both tools.
- `vx.workspace.mjs`: `turbo()` plus a project-stage plugin that sets
  `@calcom/web#build`'s outputs to `.next/server/**`, `.next/static/**`,
  `.next/cache/**`, `.next/types/**`, `.next/diagnostics/**`,
  `.next/build/**`, `.next/turbopack/**`, `.next/trace-build/**` and
  `.next/*`: everything under `.next` (490 MB, 7,863 files) except
  `.next/node_modules`, which holds 110 symlinks to `node_modules`
  directories (Next's traced dependencies). vx's artifact format
  stores regular files only and refused to save the task; Turbo's
  `.next/**` artifact carries the links. `next start` does not read
  them. Directory symlinks in artifacts are STATUS Next.
- `@calcom/app-store-cli#build` writes `../../packages/app-store/*.generated.ts`;
  mapped to `outputs.workspaceFiles` by the plugin (STATUS 138).

## Nx repos (`nx-repo.sh`)

The same arms against the repo's own Nx (`NX_DAEMON=false`,
`NX_NO_CLOUD=true`: local runner against local runner), on the
`vx.config` files `bunx @vzn/vx-migrate --from nx` wrote from the
repo's exported graph. Parity is the task graph Nx plans
(`nx run-many … --graph=<file>`) against vx's `--dry=json`. Two
bench-side rules for every Nx repo, named here: the generated configs
are rewritten from `.ts` to `.mjs` (the type import dropped), because
a package's `tsc --build` includes every `.ts` under it and compiled
the configs into `dist-ts` — what `vx-migrate --mjs` writes since
STATUS 145; and
`.vx-bench-bin/` beside the repo holds the pinned package manager
(`packageManager`), since corepack's shim resolves it through the
registry on every spawn, which vx's isolated task env cannot reach.

### TanStack/query — 7452ef6 (2026-09-10)

pnpm 11.9.0 (self-managed), Nx 22.1.3, Node 22.22. 102 projects, 573
targets, all `nx:run-script`. Scope: the repo's own `build` script's
excludes (`examples/**`, `integrations/**`): `build` = 25 tasks. Both
tools at the repo's `parallel: 5`. No adjustments beyond the two above.

### strapi/strapi — 34fdea8 (2026-09-11)

yarn 4.12.0 (`yarnPath`; the release file copied from cal.com's
checkout, corepack being unable to fetch it here), Nx 20.8.4, Node
22.22. 47 projects; 416 `nx:run-script` targets and 37
`@nx/js:release-publish` (placeholders, not benched). `build` = 39
tasks with `^build`, `--nx-ignore-cycles` as the repo's own scripts
pass it; both tools at the repo's `parallel: 8`.

- Every package script is `run -T <root bin>` — yarn's shell builtin —
  so the mapper routes them through `yarn run <name>` (STATUS 142).
- `build:code` and `build:types` share `dist/**` with `build`; vx
  refuses two tasks on one output directory, so the bench strips the
  cache block from those two siblings (they are not benched).

### novuhq/novu — fd04f7c (2026-09-11)

pnpm 11.0.9 (corepack's copy, wrapped in `.vx-bench-bin/`), Nx 21.3.11,
Node 22.22. 43 projects; 416 `nx:run-script` targets, 39
`nx:run-commands` (the lints, with workspace-root `cwd`s; not benched)
and 10 `@nx/js:release-publish` placeholders. Scope: the repo's own
`build` script's excludes (`nextjs`, `nestjs`): `build` = 37 tasks. Both
tools at the repo's `parallel: 4`.

- `pre<name>` / `post<name>` hooks ride inside the mapped command
  (STATUS 144); before that `@novu/js#build` failed on the CSS its
  `prebuild` copies.
- `libs/dal`'s `test:watch` is an empty script: the placeholder with a
  todo (STATUS 143), where `command: ''` refused the whole workspace.

### redwoodjs/redwood — a7852fb (2025-12-13): dropped

yarn 4.6.0 (no vendored release), Nx 20.3.2, 39 packages of scripts.
Its `build` target declares no outputs anywhere — `nx.json` caches it
on inputs alone and no package adds an `nx` field — so Nx's cache
replays the log and restores no `dist`; a restore arm would write
nothing under either tool. Not a runner comparison.

## Results

`docs/benchmarks.md`, "Five real Turbo repos" — the build tables — and
"Wide graphs". Raw rows per arm live in the session scratchpad only.
