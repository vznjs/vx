# `src/util/errors.ts` — clean error reporting

## Purpose

Distinguish user-input failures (config errors, missing refs, malformed
flags) from internal bugs (assertion failures, unexpected nulls).
Surfaces user errors as plain messages without a stack trace; internal
errors keep the stack so we can debug them.

## Public surface

```ts
export class UserError extends Error {
  constructor(message: string)
}
```

`UserError` instances have `.name === 'UserError'`. `bin.ts` does
`if (err instanceof UserError) print(err.message); else throw`.

## Convention

Throw `UserError` whenever the cause is user input or environment
state the user can fix without code changes:

- Malformed `vx.config.ts` (validated in `project-loader.ts`).
- Missing workspace root (`findWorkspaceRoot`).
- Bad git ref for `--affected` (`workspace/affected.ts`).
- Cycle in the task graph (`graph/task-graph.ts`).
- Duplicate package names (`workspace.ts`).
- Bad CLI flags (in `cli/run.ts`).

Throw plain `Error` (or let TypeError / RangeError propagate) for
internal bugs — those should show a full stack so we can find them.

## Tests

`tests/errors.test.ts` — verifies the `name` field, basic shape.
Real coverage comes from every module's "bad input" tests.

## `isUserError(err)`

`instanceof UserError`, plus the same class arriving from **another copy of
core**. A compiled `vx` binary carries core inside it while a workspace
plugin imports `@vzn/vx` from `node_modules`, so a plugin's `UserError` is a
different class object and `instanceof` is false across the boundary — a
plugin verb's refusal printed with a stack, and a REAPI refusal would have
read as an "internal error" (reproduced through the real binary,
2026-09-03). `bin.ts`, the scheduler and `@vzn/vx-mcp` consult this
helper; it is on the façade so a plugin can classify the same way. The
**name** `UserError` is the contract that survives the copy boundary: a
plugin may throw its own class named `UserError` without importing core's.
