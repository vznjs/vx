# `src/config.ts` — the public schema

The single source of truth for what users can write in `vx.config.ts`.
Pure types + two identity helpers; no runtime logic.

## Purpose

Defines every interface the rest of the codebase consumes:
`ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`,
`PersistentConfig`, `SandboxConfig` (with its `SandboxGrants` and
`SandboxDenials`), `CacheConfig`, `CacheInputs`, `CacheOutputs`,
`WorkspaceConfig` — and the plugin contract a workspace file declares:
`Plugin`, the `PLUGIN_HOOKS` list every table and host reads (with
`PluginHook` and the function-valued subset `PLUGIN_FUNCTION_HOOKS`),
and `PLUGIN_PACKAGE`, the symbol `definePlugin` stamps a plugin's
package name under.

Exports two helpers — `defineProject` and `defineWorkspace` — that
exist purely so TypeScript can narrow the user's literal types via the
generic parameter. A config that imports them at runtime gets the
running core's own copy — bin.ts aliases the `@vzn/vx` specifier to
its façade (cli/core-alias.ts), so the compiled binary no longer loads
a second core for an identity function (22 → 2 ms per live-evaluated
config, measured 2026-09-10). The scaffolds still write the type-only
`satisfies` form, which types the same with nothing to resolve.

## Public surface

```ts
// Types
export interface ProjectConfig
export interface WorkspaceConfig
export interface TaskConfig
export interface ExecConfig
export interface ExecEnv
export interface PersistentConfig
export interface SandboxConfig
export interface SandboxGrants
export interface SandboxDenials
export interface CacheConfig
export interface CacheInputs
export interface CacheOutputs

// The plugin contract
export interface Plugin
export const PLUGIN_PACKAGE: unique symbol
export const PLUGIN_HOOKS: readonly PluginHook[] // every hook name, in pipeline order
export type PluginHook
export const PLUGIN_FUNCTION_HOOKS: readonly PluginHook[] // the hooks that are functions (not `commands`)

// Helpers (identity functions)
export function defineProject<const T extends ProjectConfig>(config: T & DependsOnTyped<T>): T
export function defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

`defineProject`'s parameter is `T` intersected with a mapped type over
`T['tasks']` that types each task's `dependsOn` entries against the
project's own task names (`'build'`, `'^build'`, a `pkg#task`), so a
typo in a same-project dependency is a type error at the call site;
`const T` keeps the literal types.

`TaskConfig.dependsOn` is `readonly string[]` (Turbo/Nx
micro-syntax — see [`schema.md`](../schema.md)).
`CacheInputs.tasks` is the same shape with `*` / `^*` / `!` filter
extras.

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
   the generic `const T extends ProjectConfig` lets TypeScript infer the
   _literal_ types of nested fields (so task names autocomplete, union
   types narrow correctly, and `dependsOn` is checked against them).
2. **Forward compat.** If we ever need to do runtime validation or
   transformation on the config, `defineProject` is the place; user
   code already calls through it.

The function body is a one-liner today and that's by design.

## Invariants

- The exported types and helpers are the **only** public contract.
  Internal modules import them; user code imports them via `@vzn/vx`.
- No field is optional in the schema if it's required for correctness.
  When `cache` is provided, `cache.inputs.files` and
  `cache.outputs.files` are required by the type system (not just at
  runtime).
- The types are JSON-serializable. No `Function` fields, no
  `Date` objects. This is what makes the task-config digest —
  `xxh3hex(JSON.stringify(hashableConfig(config)))` in
  `task-hash.ts` — well-defined.

## Replacing this module

You wouldn't, normally — the schema is the user-facing API. Changes
here are breaking.

If you're forking the project, the things you might want to change:

- **Add a new top-level field.** Update `TaskConfig`, the validator
  (`workspace/config-schema.ts`), the key (`orchestrator/task-hash.ts`:
  `hashableConfig` strips placement-only fields) and the consumer in
  `execute-task.ts`; bump `CACHE_VERSION` if the field affects caching.
- **Drop a field.** Mark deprecated in JSDoc for a release, then
  remove. Bump `CACHE_VERSION`.
- **Tighten a field's type.** Same considerations as add, but check
  every consumer module.

## Tests

`tests/config.test.ts` covers identity behavior + generic type
preservation. Type-level correctness is enforced by
`oxlint --type-aware --type-check` in the gate across all consumers
(there is no build).
