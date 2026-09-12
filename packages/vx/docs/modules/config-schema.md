# `src/workspace/config-schema.ts` — what a config may say

## Purpose

The schema validators for `vx.config.*` and `vx.workspace.*`: every
object level, every field's shape, every rule a value must satisfy, and
the message that names the level, the accepted list and the nearest
spelling when a key is unknown. Split from `project-loader.ts` on
2026-09-10 so the two concerns read separately: this module decides
what a config may SAY, the loader decides HOW a file is evaluated.

## Public surface

```ts
export function validateProjectConfig(config: ProjectConfig, where: string): void
export function validateWorkspace(config: WorkspaceConfig, configPath: string): void
```

`validateProjectConfig` is the one boundary three readers cross with the
same object shape: the loader after evaluation, `lockfile.ts` on a frozen
entry read back from `vx-lock.json` (a hand-editable file — the same
boundary), and `orchestrator/projects.ts` after each plugin's `project`
edit (a broken edit is refused naming the plugin). `validateWorkspace`
runs once per `vx.workspace.*` load: fields, plugin shapes, and the verb
rules (a plugin may not shadow a core verb; a verb has one owner).

## Rules

- **Unknown keys are refused at every object level** — `tasks`, the
  task, `exec`, `exec.env`, `exec.persistent`,
  `exec.sandbox` and its `allow` / `deny` / `ignore`, `cache`,
  `cache.inputs`, `cache.outputs`, and the workspace top level. The
  message is `<level> has unknown field "<key>" (allowed: …)` plus
  ` — did you mean <x>?` when a candidate is within two edits
  (`util/edit-distance.ts`), never a guess beyond that.
- `cache` needs both `inputs` and `outputs`; a persistent task may not
  carry `cache`; `dependsOn` entries are validated as specs.
- Globs may not carry a `..` path segment, a negation alone, or a
  double negation; workspace-anchored globs have their own checks.
- Timeouts are bounded by `MAX_TIMEOUT_MS` (a larger delay would fire
  at 1 ms); `resources` are cores and megabytes; `sandbox` grants are
  typed per field (paths, names, booleans, `network`, `unixSockets`).

## What it does NOT do

- Evaluate or read any file; it sees an object.
- Fold anything into a cache key — `task-hash.ts` does, from the
  validated object.
- Apply defaults. A validated config is the user's object, untouched.

## Tests

`tests/schema-unknown-keys.test.ts` (the walk over every level, its
level list pinned); `tests/schema-doc-drift.test.ts` (every rule and
message against `docs/schema.md`); `tests/project-loader.test.ts`,
`tests/timeout-bounds.test.ts`, `tests/workspace-files.test.ts`,
`tests/inputs-resolution.test.ts` (individual rules);
`tests/sandbox-hint.test.ts` (a runtime message's field names validate
here).

## Replacing this module

A stricter or looser schema is a change here and in `docs/schema.md`
together — the drift test holds the two to each other.
