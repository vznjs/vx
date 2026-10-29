# Shared patterns with Turborepo and Nx

The companion to [`comparison.md`](./comparison.md). That doc lists
what Turbo / Nx do that vx doesn't. This one lists what we deliberately
inherited or independently converged on — the parts a Turbo or Nx user
should find familiar.

Every row cites the vx source file that implements the pattern; where
a comment on the line names the upstream tool, that's the explicit
parity claim.

## The 30-second view

vx's overall shape is **Turborepo with three swaps and a few subtractions**:

- per-package config (Turbo's `turbo.json` → vx's `vx.config.ts`),
- opt-in cache keyed by inputs + env + upstream + lockfile,
- shell-only task contract,
- tar artifact + a plugin-driven remote-cache layer,
- topological scheduler with bounded parallelism.

The swaps: TypeScript config instead of JSON, resolved-config hash
instead of file hash, strict output ownership instead of additive
restore. Everything else lines up with Turbo or Nx by design.

## Subsystem-by-subsystem

### Cache key composition

The set of bytes fed into the hash mirrors Turbo's key recipe; the
package-manager parts come from a plugin.

| Component                              | Turbo        | Nx                     | vx     | vx source                                     |
| -------------------------------------- | ------------ | ---------------------- | ------ | --------------------------------------------- |
| Task identity (`project#task`)         | yes          | yes                    | yes    | `src/cache/layer.ts` (`CacheKeyInput.taskId`) |
| Resolved command + env declarations    | yes          | yes                    | yes    | `src/cache/layer.ts` (`taskConfigHash`)       |
| Declared input file contents           | yes          | yes                    | yes    | `src/cache/layer.ts` (`inputFiles`)           |
| Declared env-var **values** at runtime | yes          | yes                    | yes    | `src/cache/layer.ts` (`envValues`)            |
| Upstream task hashes (cascade)         | yes          | yes                    | yes    | `src/cache/layer.ts` (`upstreamHashes`)       |
| Workspace lockfile                     | yes          | yes                    | plugin | `@vzn/vx-lockfile` (`VxPlugin.fingerprint`)   |
| Forwarded CLI args (after `--`)        | yes          | yes                    | yes    | `src/cache/layer.ts` (`forwardArgs`)          |
| Project `package.json` bytes           | via lockfile | `externalDependencies` | plugin | `@vzn/vx-lockfile` (an input file)            |

Core keys no package file (2026-10-14): the lockfile and each
project's `package.json` key a task through `@vzn/vx-lockfile`, which
claims the lockfile and adds `package.json` to every cached task's
inputs, so narrow `inputs.files` like `['src/**']` doesn't miss a
`package.json` dep bump.

The two **divergences** from Turbo's recipe — TypeScript-resolved
config hash and per-task forwarded-args fold — are documented in
[`caching.md`](./caching.md) and listed under "Where vx is ahead" in
[`comparison.md`](./comparison.md).

### Input enumeration

| Pattern                                                                                                        | Source     | vx source                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| Defer to git: tracked from `git ls-files -s -v`, untracked-but-not-ignored from `git status --porcelain -uall` | Turbo + Nx | `src/cache/git-inputs.ts`, `src/cache/inputs.ts` ("same as Turbo and Nx") |
| Git blob OIDs as per-file content hashes (index-harvested)                                                     | Turbo      | `src/cache/git-inputs.ts` + `src/cache/file-hashes.ts`                    |
| Project-boundary enforcement (no cross-project globs)                                                          | Turbo + Nx | `src/workspace/nested-dirs.ts`                                            |

(vx hard-requires git — there is no fallback walker; a non-repo
workspace gets a clean `UserError` telling the user to `git init`.)

### `dependsOn` micro-syntax

The string DSL is verbatim Turbo (Nx supports the same forms plus a
richer object form).

| Form         | Meaning                             | Source                             | vx source                                                                                       |
| ------------ | ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `'lint'`     | Same project, other task            | Turbo + Nx                         | `src/util/dependency-spec.ts` ("Turbo/Nx-style")                                                |
| `'^lint'`    | Same task in workspace dependencies | Turbo + Nx                         | `src/util/dependency-spec.ts`                                                                   |
| `'pkg#lint'` | Arbitrary other package's task      | Turbo + Nx                         | `src/util/dependency-spec.ts`                                                                   |
| `'*' / '^*'` | Wildcard upstream (filter-only)     | Turbo's `$TURBO_DEFAULT$`-adjacent | `src/util/dependency-spec.ts` ("filter-only"), `src/orchestrator/upstream.ts` ("like Turbo/Nx") |
| `'!<form>'`  | Negation (filter-only)              | Turbo `inputs` exclusion           | `src/util/dependency-spec.ts` ("filter-only")                                                   |

Graph construction rejects bare wildcards / negation in `dependsOn`
itself (`src/graph/task-graph.ts`) — they're filter-only, as the
parser's docblock marks them (`src/util/dependency-spec.ts`).

### Filter DSL + selection

| Capability                                                    | Source       | vx source                                                                                  |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| pnpm-style `--filter` (`pkg`, `pkg...`, `...pkg`, path globs) | Turbo + pnpm | `src/workspace/filter.ts`                                                                  |
| Transitive-dep expansion (`pkg...`)                           | Turbo + pnpm | `src/workspace/filter.ts` (the DSL comment)                                                |
| `[<since>]` git-relative selection                            | Turbo        | `src/workspace/filter.ts` ("Turbo-style"), `src/workspace/affected.ts` ("Matches Turbo's") |
| `--affected[=<base>]` flag on `vx run`                        | Turbo + Nx   | `src/workspace/affected.ts`                                                                |
| `pkg#task` direct addressing                                  | Turbo + Nx   | `src/cli/run.ts`                                                                           |

### Workspace discovery

| Capability                                            | Source       | vx source                         |
| ----------------------------------------------------- | ------------ | --------------------------------- |
| Read `pnpm-workspace.yaml` (adoption)                 | pnpm + Turbo | `@vzn/vx-migrate`'s `packages.ts` |
| Read `package.json` `workspaces` (adoption)           | Turbo        | `@vzn/vx-migrate`'s `packages.ts` |
| Build package-dep graph from workspace `dependencies` | Turbo + Nx   | `src/workspace/package-graph.ts`  |
| Lockfile fingerprint at workspace level               | Turbo + Nx   | `src/workspace/fingerprint.ts`    |

### Cache topology

| Layer                                    | Turbo                              | Nx                 | vx                                                             | vx source                                                            |
| ---------------------------------------- | ---------------------------------- | ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Local: content-addressed artifacts       | tarball-per-hash in `.turbo/cache` | `.nx/cache` SQLite | SQLite index + `<hash>.tar.zst`, shared in `~/.vx/<id>/cache/` | `src/cache/cache.ts`                                                 |
| Local: skip-restore when tree is current | yes (fingerprint check)            | yes                | yes — `isOutputsCurrent` stat check → up-to-date               | `src/cache/output-index.ts`                                          |
| Read-through then write-through layering | yes                                | yes                | yes                                                            | `src/cache/layered-cache.ts`                                         |
| Run-history table for analytics          | (no — `--summarize` JSON)          | (Nx Cloud)         | `runs` + `invocations` tables in `cache.db`                    | `src/cache/run-history.ts` (tables created in `src/cache/schema.ts`) |

### Remote cache wire

The remote cache is **plugin-driven** (owner directive 2026-07-10): core keeps the seams
(`LayeredCache` + the `RemoteCacheLayer` interface + the `cache`
plugin capability), and a plugin ships the wire — `@vzn/vx-reapi` speaks
Bazel's ActionCache + CAS, so any REAPI server works as a remote cache.
Turbo `/v8/artifacts` compatibility was
dropped from core — `turboCache()` in `@vzn/vx-migrate` is that wire as a plugin;
the recipe for any other lives in the plugins guide.

### Tar artifact format

Inside the tar we depart from Turbo (we don't mimic Turbo's
`.turbo/turbo-<task>-<project>.log` file naming — our metadata lives in
SQLite). But the **on-the-wire framing** stays POSIX-tar so any
Turbo-aware cache server can transit our blobs unchanged.

| Pattern                                   | Source                                        | vx source                                |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| POSIX tar framing, in-process pack        | Turbo (Rust `tar` crate, `Header::new_gnu()`) | `src/cache/archive.ts` (`tar-stream.ts`) |
| No AppleDouble `._*` companions           | Turbo (in-process writer, no recurse)         | `src/cache/archive.ts` (no `tar` spawn)  |
| Entry-name validation on the extract side | (vx-only defense-in-depth)                    | `src/cache/archive.ts`                   |
| zstd compression on the wire              | Turbo                                         | `Bun.zstdCompress` (tar.zst artifacts)   |

### Scheduler + execution

| Pattern                                                       | Source                                             | vx source                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Topological order, bounded parallelism                        | Turbo + Nx                                         | `src/graph/scheduler.ts`                                                    |
| Cascade skip: failed task's transitive dependents are skipped | Turbo (mid-mode) + Nx                              | `src/graph/scheduler.ts`                                                    |
| Independent siblings continue past failure                    | Turbo `--continue=dependencies-successful`         | `src/graph/scheduler.ts`                                                    |
| Persistent / long-running tasks (dev servers)                 | Turbo `persistent`, Nx `continuous`                | `src/exec/runner.ts` (`runPersistent`) + `src/orchestrator/execute-task.ts` |
| Project-local `node_modules/.bin` on PATH                     | Turbo + pnpm                                       | `src/exec/env.ts` (`binPaths`)                                              |
| Project-`package.json` invalidation, by a plugin              | Turbo (via lockfile) + Nx (`externalDependencies`) | `@vzn/vx-lockfile` (its `project` stage lists it as an input)               |

### Output handling

| Pattern                                                            | Source     | vx source                                        |
| ------------------------------------------------------------------ | ---------- | ------------------------------------------------ |
| Glob-based `outputs` declaration                                   | Turbo + Nx | `src/config.ts`, `src/cache/inputs.ts`           |
| Restore by file (archive extract, not symlink/hardlink)            | Turbo + Nx | `src/cache/archive.ts` (`extractArtifactStream`) |
| Log replay on cache hit                                            | Turbo + Nx | `src/orchestrator/hit-restore.ts`                |
| **Wipe outputs before exec AND before restore** (strict ownership) | (vx-only)  | `src/cache/inputs.ts` (`cleanOutputs`)           |

### CLI conventions

| Flag / behavior                                                                    | Source         | vx source                           |
| ---------------------------------------------------------------------------------- | -------------- | ----------------------------------- |
| `--` separator forwards args to task                                               | Turbo          | `src/cli/run.ts`                    |
| `--filter` DSL (pnpm shape)                                                        | Turbo + pnpm   | `src/workspace/filter.ts`           |
| `--concurrency <n>`                                                                | Turbo          | `src/cli/run.ts`                    |
| `--no-cache` (all off) / `--force` (reads off, writes on) — distinct, not synonyms | Turbo-adjacent | `src/cli/run.ts`                    |
| `--dry` / `--dry=json` (plan output)                                               | Turbo          | `src/orchestrator/plan.ts`          |
| `--profile[=<path>]` (Chrome-trace)                                                | Turbo          | `src/orchestrator/run-artifacts.ts` |
| `--affected[=<base>]`                                                              | Turbo + Nx     | `src/workspace/affected.ts`         |
| `watch <task>` subcommand                                                          | Turbo + Nx     | `src/cli/watch.ts`                  |

### Output presentation

| Pattern                                              | Source                                           | vx source                                     |
| ---------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Framed per-task blocks (`┌─ … └─`)                   | Turbo                                            | `src/report/framed-output.ts`                 |
| End-of-run summary footer (task/cache meters + time) | Turbo-adjacent (vx renders meters, not a banner) | `src/report/summary.ts`                       |
| Per-task output buffered until task finishes         | Turbo                                            | `src/report/framed-output.ts` ("Turbo-style") |

(There is no `>>> FULL TURBO`-style all-cached banner — a fully-green
cache meter carries the message.)

## Performance

Sharing the patterns doesn't mean sharing the overhead. On the
head-to-head's %bench.tasks%-task synthetic workspace, each tool in its
native config, the time each adds over the ideal run:

| Runner    | Nothing changed    | Nothing changed, outputs restored |
| --------- | ------------------ | --------------------------------- |
| vx        | %bench.vx.warm%    | %bench.vx.restore%                |
| Turborepo | %bench.turbo.warm% | %bench.turbo.restore%             |
| Nx        | %bench.nx.warm%    | %bench.nx.restore%                |

A cached run is all runner overhead. Cold builds are compared by the
time the runner adds, on [`benchmarks.md`](./benchmarks.md).

Full breakdown + methodology in [`benchmarks.md`](./benchmarks.md).

## Where the lineage diverges

For features Turbo or Nx have that vx **lacks**, see
[`comparison.md` § Gaps](./comparison.md#gaps-for-vznvx-the-running-list).

For places vx made a deliberately different call (TypeScript config,
resolved-config hash, strict output ownership, no daemon, no TUI), see
[`comparison.md` § Where vx is ahead](./comparison.md#where-vx-is-ahead)
and [`README.md`](./README.md#the-problems).

## Quick citation index

Every "Turbo" / "Nx parity" claim above is anchored in a comment in
the vx source. To audit:

```sh
grep -rn "Turbo\|Nx parity\|turborepo" src/
```

Each line is a deliberate decision to mirror an upstream pattern, and
every phrase this page quotes beside a source path is held to that
file by `tests/patterns-doc-drift.test.ts`. Adding to that list is preferable to inventing
new vocabulary — vx's value is in the swaps, not in renaming the
parts we kept.
