# `config.ts` — the public schema

The single source of truth for what users can write in `vzn.config.ts`.
Pure types + two identity helpers; no runtime logic.

## Purpose

Defines every interface the rest of the codebase consumes:
`ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`, `TaskDependsOn`,
`CacheConfig`, `CacheInputs`, `CacheOutputs`, `WorkspaceConfig`.

Exports two helpers — `defineProject` and `defineWorkspace` — that
exist purely so TypeScript can narrow the user's literal types via the
generic parameter.

## Public surface

```ts
// Types
export interface ProjectConfig
export interface WorkspaceConfig
export interface TaskConfig
export interface ExecConfig
export interface ExecEnv
export interface TaskDependsOn
export interface CacheConfig
export interface CacheInputs
export interface CacheOutputs

// Helpers (identity functions)
export function defineProject<T extends ProjectConfig>(config: T): T
export function defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

See [`../schema.md`](../schema.md) for the full reference of every
field's meaning.

## Why an identity helper

```ts
export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}
```

Two reasons:

1. **Type inference.** When a user writes `defineProject({ tasks: {...} })`,
   the generic `T extends ProjectConfig` lets TypeScript infer the
   _literal_ types of nested fields (so `tasks: 'build'` autocompletes,
   union types narrow correctly).
2. **Forward compat.** If we ever need to do runtime validation or
   transformation on the config, `defineProject` is the place; user
   code already calls through it.

The function body is a one-liner today and that's by design.

## Invariants

- The exported types and helpers are the **only** public contract.
  Internal modules import them; user code imports them via `@vzn/run`.
- No field is optional in the schema if it's required for correctness.
  When `cache` is provided, `cache.inputs.files` and
  `cache.outputs.files` are required by the type system (not just at
  runtime).
- The types are JSON-serializable. No `Function` fields, no
  `Date` objects. This is what makes `taskConfigHash =
sha256(JSON.stringify(config))` well-defined.

## Replacing this module

You wouldn't, normally — the schema is the user-facing API. Changes
here are breaking.

If you're forking the project, the things you might want to change:

- **Add a new top-level field.** Update `TaskConfig`, propagate
  through `orchestrator.ts:executeTask`, and bump `CACHE_VERSION` if
  the field affects caching.
- **Drop a field.** Mark deprecated in JSDoc for a release, then
  remove. Bump `CACHE_VERSION`.
- **Tighten a field's type.** Same considerations as add, but check
  every consumer module.

## Tests

`config.test.ts` covers identity behavior + generic type preservation.
Type-level correctness is enforced by `tsc -b` at build time across
all consumers.
