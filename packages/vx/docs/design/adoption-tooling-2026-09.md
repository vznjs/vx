# Adoption tooling leaves core (2026-09-10)

## Decision

Core reads no other runner's format. `vx init` (package.json scripts)
stays; Turbo and Nx migrations are `@vzn/vx-migrate`, a package with its
own bin; the Turbo mapper belongs to the `turbo()` plugin, which runs it
live (its own package `@vzn/vx-turbo` until 2026-09-11, `@vzn/vx-migrate`
since: one adoption package).
What core keeps is the seam every adoption tool shares: a `MigrationPlan`
in, files out (`workspace/migration.ts`, `applyMigration` on the façade).

## Why a bin and not a `commands` plugin verb

A plugin verb is consulted only when the cwd is inside a workspace that
declares the plugin — and the migration is the command a user runs
BEFORE any vx file exists. `bunx @vzn/vx-migrate` needs nothing in the
repo; it writes the workspace file itself. The same reasoning kept
`vx init` in core: the first command a fresh workspace runs must be in
the binary the user has.

## Why the mapper lives in the plugin, not the migrator

Two consumers, one mapping: `turbo()` runs `turbo.json` under vx
with nothing written, `@vzn/vx-migrate` renders the same mapping to
files. The plugin is the one a workspace keeps; the migrator is run
once. So the migrator depends on the plugin, never the reverse, and the
façade carries neither.

## What the seam guarantees

A config written by `vx init` and one written by `@vzn/vx-migrate` read
the same: the type-only `satisfies ProjectConfig` form, the workspace
file with an empty plugin list (the floor), the overwrite guard that
aborts before any byte lands, the report with `TODO(vx-migrate)` lines
for what a source could not say. A third tool (Lerna, Bazel, a bespoke
script) gets all of it by returning a plan.

## Cost and size

Core: −1,475 lines (`cli/migrate*.ts`, `workspace/turbo.ts`), +~330
(`workspace/migration.ts`, `migrate-scripts.ts`, `cli/init.ts`). Zero
warm-path effect: none of it ran on `vx run`. The façade's runtime export
set changed by −1 / +5 (pinned).
