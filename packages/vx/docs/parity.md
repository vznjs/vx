# Turbo / Nx parity map

What a Turborepo or Nx user relies on, the vx spelling of it, and the
test that proves it. Two end-to-end suites run the real CLI on one
four-package fixture (`tests/helpers/parity.ts`: `app → ui → lib`,
`app → lib`, `docs` alone) and name each case for the upstream contract:
`tests/parity-turbo.test.ts` (turborepo.dev, 2.10) and
`tests/parity-nx.test.ts` (nx.dev, 23). They are the scan surface; the
right column names the suite that pins the behaviour in depth. A
deliberate divergence is marked **≠** and explained.

## Turbo

| Turbo                                                              | vx                                                                          | Deep pin                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `"dependsOn": ["^build"]`                                          | `dependsOn: ['^build']`                                                     | `tests/task-graph.test.ts`                                                             |
| `"dependsOn": ["build"]` (same package)                            | `dependsOn: ['build']`                                                      | `tests/task-graph.test.ts`                                                             |
| `"dependsOn": ["pkg#task"]`                                        | `dependsOn: ['pkg#task']`                                                   | `tests/dependency-spec.test.ts`                                                        |
| `--only`                                                           | `--exclude-dependencies[=<names>]`                                          | `tests/cli.test.ts`                                                                    |
| `--dry`, `--dry=json`                                              | `--dry`, `--dry=json`                                                       | `tests/plan-format.test.ts`, `tests/plan-predict.test.ts`                              |
| `--graph=file.dot`                                                 | `--graph[=<path>]` (DOT; edges point dependency → dependent)                | `tests/cli.test.ts`                                                                    |
| `--filter=pkg`, `pkg...`, `...pkg`, `./dir`, `!pkg`                | the same DSL (`docs/cli.md` § Filter DSL)                                   | `tests/filter.test.ts`                                                                 |
| `--filter=[ref]`, `--affected`                                     | `--filter '[<ref>]'`, `--affected[=<ref>]`; `...[<ref>]` adds dependents    | `tests/affected.test.ts`                                                               |
| `--filter` + `--affected` **intersect**                            | **≠** they **union** (`docs/comparison.md` § Filter DSL)                    | `tests/filter.test.ts`                                                                 |
| a filter matching nothing exits 1                                  | the same                                                                    | `tests/task-selection.test.ts`                                                         |
| second run hits; missing `outputs` restored; logs replayed         | the same, with outputs **cleaned** before exec and restore (**≠** additive) | `tests/orchestrator.test.ts`, `tests/output-dirs.test.ts`                              |
| `"inputs": [...]` narrows the hash                                 | `cache.inputs.files` (required; nothing is inferred)                        | `tests/inputs.test.ts`, `tests/task-hash.test.ts`                                      |
| `"inputs": ["src/"]`, `"outputs": ["dist"]` (a directory literal)  | the same: a literal is the file or its whole tree                           | `tests/inputs-resolution.test.ts`                                                      |
| `--filter=./apps/*` (a path glob)                                  | `--filter './apps/*'`, `{apps/**}` — over root-relative project dirs        | `tests/filter.test.ts`                                                                 |
| `--affected` diffs from the merge base                             | the same                                                                    | `tests/affected.test.ts`                                                               |
| `TURBO_CACHE=remote:rw` with no remote → "Remote caching disabled" | `--cache=remote:rw` with no remote layer → one status line                  | `tests/parity-turbo.test.ts`                                                           |
| a dependency's change re-hashes dependents                         | upstream **input** keys are folded (never outputs)                          | `tests/task-hash-derive.test.ts`, `tests/upstream.test.ts`                             |
| `"env": ["MODE"]`                                                  | `cache.inputs.env: ['MODE']`                                                | `tests/env.test.ts`                                                                    |
| `"passThroughEnv"`                                                 | `exec.env.passThrough` (reaches the command, never the hash)                | `tests/env.test.ts`                                                                    |
| `"cache": false`                                                   | no `cache` block (`noCache: true` in `--summarize`)                         | `tests/no-cache-word.test.ts`                                                          |
| `--force`                                                          | `--force` (reads off, writes on)                                            | `tests/cli.test.ts`                                                                    |
| `--cache=local:r,remote:` / `--no-cache`                           | `--cache=<spec>` / `--no-cache`                                             | `tests/cli.test.ts`, `tests/download-policy.test.ts`                                   |
| `turbo run test -- --watch`                                        | `vx run test -- --watch` (forwarded args are in the hash)                   | `tests/cli.test.ts`                                                                    |
| the global hash covers the lockfile                                | the workspace fingerprint, in every key; `@vzn/vx-lockfile` narrows it      | `tests/fingerprint.test.ts`, `tests/lockfile-claim.test.ts`                            |
| a package's `package.json` is in its hash                          | the same                                                                    | `tests/task-hash.test.ts`                                                              |
| `--continue=dependencies-successful` (default)                     | `--continue=deps-ok` (default)                                              | `tests/continue-taint.test.ts`                                                         |
| `--continue=always`                                                | `--continue` (a task built on a failure runs but is never saved)            | `tests/continue-taint.test.ts`                                                         |
| `--continue=never`                                                 | `--continue=never`                                                          | `tests/scheduler.test.ts`                                                              |
| graceful shutdown (`graceful_shutdown_test.rs`)                    | SIGTERM, `VX_KILL_GRACE_MS`, SIGKILL; second signal skips the grace         | `tests/signal-handling.test.ts`                                                        |
| recursive `turbo run` refused (`recursive_turbo_test.rs`)          | `VX_RUN_WORKSPACE` marker; `vx run` in its own workspace is refused         | `tests/recursive-run.test.ts`                                                          |
| failures are never cached                                          | the same                                                                    | `tests/execute-task.test.ts`                                                           |
| `--output-logs=errors-only`, `hash-only`, `none`                   | the same (`full` too; the default follows the run's flow)                   | `tests/output-flow.test.ts`                                                            |
| `--summarize`                                                      | `--summarize[=<path>]`                                                      | `tests/run-artifacts.test.ts`                                                          |
| `--profile`                                                        | `--profile[=<path>]`                                                        | `tests/run-artifacts.test.ts`                                                          |
| `--concurrency`                                                    | `--concurrency <n \| n%>`                                                   | `tests/scheduler.test.ts`                                                              |
| `"persistent": true`                                               | `exec.persistent: { readyWhen }` (readiness gates dependents)               | `tests/persistent.test.ts`, `tests/dev.test.ts`                                        |
| `turbo watch`                                                      | `vx watch <task>`                                                           | `tests/watch-rules.test.ts`, `tests/watch-loop.test.ts`, `tests/watch-signals.test.ts` |
| `turbo prune`                                                      | `@vzn/vx-prune`                                                             | `packages/vx-prune/tests`                                                              |
| `--summarize` + Vercel Remote Cache                                | `@vzn/vx-turbo-cache` (same wire, self-hosted or Vercel)                    | `packages/vx-turbo-cache/tests`                                                        |
| `globalDependencies`, `globalEnv`, `$TURBO_ROOT$`, `extends`       | **≠** rejected: configs are TypeScript and compose by import                | `docs/comparison.md` § Explicitly rejected                                             |

## Nx

| Nx                                                                                 | vx                                                                                    | Deep pin                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `nx run app:build`                                                                 | `vx run app#build`                                                                    | `tests/task-selection.test.ts`                               |
| `nx run-many -t build test`                                                        | `vx run build test --all`                                                             | `tests/task-selection.test.ts`                               |
| `nx run-many -t lint -p app ui`                                                    | `vx run lint --filter app --filter ui`                                                | `tests/filter.test.ts`                                       |
| `--exclude docs`                                                                   | `--filter '!docs'`                                                                    | `tests/filter.test.ts`                                       |
| `nx affected` (changed **and dependents**)                                         | **≠** `--affected` is the changed set; `--filter '...[<ref>]'` is Nx's selection      | `tests/affected.test.ts`                                     |
| `nx affected --base=main`                                                          | `--affected=main`                                                                     | `tests/affected.test.ts`                                     |
| `packages: ['packages/*', '!packages/fixtures']` (a negated workspace glob)        | the same: negations subtract in discovery                                             | `tests/workspace.test.ts`                                    |
| `nx affected` with nothing changed exits 0                                         | the same (`nothing affected since <ref>`)                                             | `tests/affected.test.ts`                                     |
| `--parallel=3`                                                                     | `--concurrency 3`                                                                     | `tests/scheduler.test.ts`                                    |
| `--skipNxCache`                                                                    | `--no-cache`                                                                          | `tests/cli.test.ts`                                          |
| `--nxBail`                                                                         | `--continue=never`                                                                    | `tests/scheduler.test.ts`                                    |
| `nx show projects`, `nx show project app --json`                                   | `vx show`, `vx show app --format json`                                                | `tests/show-info.test.ts`                                    |
| `nx graph`                                                                         | `vx run <task> --graph` (DOT)                                                         | `tests/cli.test.ts`                                          |
| `"dependsOn": ["^build"]` / `{ projects: "dependencies" }`                         | `dependsOn: ['^build']`                                                               | `tests/task-graph.test.ts`                                   |
| `{ projects: ["ui"], target: "build" }`                                            | `dependsOn: ['ui#build']`                                                             | `tests/dependency-spec.test.ts`                              |
| `"dependsOn": ["build-*"]` (wildcards)                                             | `dependsOn: ['check.*']`, `['^build.*']`                                              | `tests/wildcard-depends.test.ts`                             |
| a target that only aggregates                                                      | a task with no `exec` — a group; its members run, it is not a task                    | `tests/task-graph.test.ts`, `tests/tally.test.ts`            |
| `{ "runtime": "node -v" }` input                                                   | `cache.inputs.runtime: ['node -v']` (`workspaceRuntime` at the root)                  | `tests/runtime-inputs.test.ts`                               |
| `{ "env": "NODE_ENV" }` input                                                      | `cache.inputs.env: ['NODE_ENV']`                                                      | `tests/env.test.ts`                                          |
| `{workspaceRoot}/tsconfig.base.json` input                                         | `cache.inputs.workspaceFiles: ['tsconfig.base.json']`                                 | `tests/workspace-files.test.ts`                              |
| `"outputs"` restored on a hit                                                      | `cache.outputs.files` (cleaned before exec and restore, **≠** additive)               | `tests/orchestrator.test.ts`                                 |
| `project.json` / `package.json` changes re-hash                                    | the resolved config and the project `package.json` are in every key                   | `tests/config-staleness.test.ts`, `tests/task-hash.test.ts`  |
| failures are never cached                                                          | the same                                                                              | `tests/execute-task.test.ts`                                 |
| `"continuous": true`                                                               | `exec.persistent: { readyWhen }`                                                      | `tests/persistent.test.ts`                                   |
| `nx watch`                                                                         | `vx watch <task>`                                                                     | `tests/watch-rules.test.ts`, `tests/watch-loop.test.ts`      |
| Nx Cloud's flaky-task flag                                                         | **local**: same key, both outcomes → the footer, `--summarize` `flaky`, `vx info`     | `tests/flaky.test.ts`, `tests/failure-mode.test.ts`          |
| lockfile-aware affected / hashing (the daemon's pruned lockfile)                   | `@vzn/vx-lockfile`: per-project dependency closures, `--affected` follows             | `packages/vx-lockfile/tests`, `tests/lockfile-claim.test.ts` |
| `nx reset`                                                                         | `vx cache prune`                                                                      | `tests/cache-hygiene.test.ts`                                |
| `namedInputs`, `targetDefaults`, `{projectRoot}` tokens, `.env` auto-loading, tags | **≠** rejected: TypeScript configs compose by import                                  | `docs/comparison.md` § Explicitly rejected                   |
| Nx Cloud (agents, dashboard, DTE)                                                  | **≠** not in this repo: the `executor` / `cache` / `telemetry` seams, `@vzn/vx-reapi` | `packages/vx-reapi/tests`                                    |

## Reading the map

- Every row's vx spelling is documented in `docs/cli.md` or
  `docs/schema.md`; the parity suite asserts the row against the real
  CLI, the deep pin asserts the edge cases.
- The three **≠** rows that change what a command selects or leaves on
  disk — union not intersection, changed-not-dependents, cleaned-not-
  additive outputs — are decisions, recorded in `docs/comparison.md`
  § Deliberate divergences with the reasoning.
- What neither runner does and vx does — sandboxed tasks, the
  resolved-config hash, `vx lock --frozen`, `vx why`, restore-ahead
  scheduling — is `docs/comparison.md` § Where vx is ahead; the parity
  map lists only what a user of the other runner would look for.
