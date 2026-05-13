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
