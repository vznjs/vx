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
export function validateProjectConfig(config: ProjectConfig, configPath: string): void
export function validateWorkspace(config: WorkspaceConfig, configPath: string): void

// json-data.ts: the JSON-data rule (item 701)
export interface NonJsonValue {
  path: string // as the validator writes it: tasks.build.description, dependsOn[1]
  is: string // a function, NaN, an instance of Map, …
}
export function nonJsonPaths(value: unknown): NonJsonValue[]
export function nonJsonMessage(configPath: string, found: NonJsonValue): string
```

`validateProjectConfig` is the one boundary three readers cross with the
same object shape: the loader after evaluation, `lockfile.ts` on a frozen
entry read back from `vx-lock.json` (a hand-editable file — the same
boundary), and `orchestrator/projects.ts` after each plugin's `project`
edit (a broken edit is refused naming the plugin). `validateWorkspace`
runs once per `vx.workspace.*` load: fields, plugin shapes, and the verb
rules (a plugin may not shadow a core verb; a verb has one owner).

## Rules

- **A project config is JSON data** (item 701). The key folds
  `JSON.stringify` of each task's config, `vx lock` stores that JSON,
  and a repeat load crosses back from the config worker as JSON, so a
  value JSON cannot carry was refused by one path and dropped by the
  other (`description: () => 'x'` failed `vx run` and passed `vx watch`),
  or sat outside the key on both (a `Map` as `exec.sandbox`, a hole in
  `dependsOn`). `nonJsonPaths` names every such value — a function,
  symbol or bigint, `NaN` / `±Infinity`, `undefined` inside an array (a
  hole too), a cycle, an object whose prototype is neither
  `Object.prototype` nor `null` and is not an array — and
  `validateProjectConfig` refuses the first one before the schema,
  after the file's path: "tasks.build.description is a function — a
  config must be JSON data, because the cache key folds its JSON". An `undefined`
  PROPERTY is allowed (JSON drops it, the schema reads it as absent, conditional
  spreads write it). The config worker (config-eval.ts) and the
  playground's worker run the same function, embedded by its source text
  (`nonJsonPaths.toString()`), before their `JSON.stringify`, and report
  with `nonJsonMessage`, so there is one copy of the rule and one
  message. It changes no key: a config that passes is the object it was.
  `validateWorkspace` does not apply it: plugins are objects of
  functions, the file never crosses the worker, and no key folds it.
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
  at 1 ms); `sandbox` grants are typed per field (paths, names,
  booleans, `network`, `unixSockets`).

## What it does NOT do

- Evaluate or read any file; it sees an object.
- Fold anything into a cache key — `task-hash.ts` does, from the
  validated object.
- Apply defaults. A validated config is the user's object, untouched.

## Tests

`tests/schema-unknown-keys.test.ts` (the walk over every level, its
level list pinned); `tests/config-eval.test.ts` § item 701 (each
non-JSON kind refused by the first load and by the worker with one
message, the controls, the key's JSON unchanged); `tests/schema-doc-drift.test.ts` (every rule and
message against `docs/schema.md`); `tests/project-loader.test.ts`,
`tests/timeout-bounds.test.ts`, `tests/workspace-files.test.ts`,
`tests/inputs-resolution.test.ts` (individual rules);
`tests/sandbox-hint.test.ts` (a runtime message's field names validate
here).

## Replacing this module

A stricter or looser schema is a change here and in `docs/schema.md`
together — the drift test holds the two to each other.
