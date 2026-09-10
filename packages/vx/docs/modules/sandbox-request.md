# `src/orchestrator/sandbox-request.ts` — the sandbox half of a request

## Purpose

What a sandboxed task may read and write, where denials are reported,
and the filesystem groundwork a bind needs. Built once per attempt by
`execute-task.ts` for the cached path (handed to the executor inside
the `ExecuteRequest`) and the persistent path (spawned in place).
Moved out of `execute-task.ts` on 2026-09-09 as pure code motion: the
concern has no cache-key or save logic in it.

## Public surface

```ts
// Prepare the runtime for a run when any task opts in; null when none did.
// Starting it is `arm()`, called by execute-task on the FIRST task that
// executes inside a sandbox and memoized — a run of cache hits never probes
// or starts anything. `arm()` refuses (UserError) when a task needs a
// sandbox the platform lacks. The proxy allowlist is the union of every
// sandboxed task's domains, and the unix-socket allowance (a `localBinding`
// port list, or `unixSockets`) is armed for the run the same way — the
// runtime reads both at `initialize()` only. The union of every
// task's `allow.network`, computed up front.
export function prepareSandbox(nodes: Iterable<TaskNode>): SandboxArmer | null

export function sandboxRequestFor(
  node: TaskNode,
  sandbox: NonNullable<ExecConfig['sandbox']>,
  workspaceRoot: string,
): Promise<NonNullable<ExecuteRequest['sandbox']>>
```

## Rules

- **Nothing is derived from `cache`.** `cache.inputs` says what
  INVALIDATES a task; `sandbox.allow` says what it may TOUCH. A
  sandboxed task declares its own reads and writes.
- **`node_modules` is the one grant core makes** — the project's and
  the workspace root's, plus the real path of every workspace link in
  them (one level, and one level inside `@scope/`): a dependency is
  not a reach-out.
- **Enforcement anchors at the workspace root, reporting at the
  project.** Every sibling and root file is denied; only denials inside
  the project's own directory are reported, because those are the ones
  the cache key never folded.
- **Binds need paths.** bwrap silently no-ops a bind on a missing path,
  so declared write paths are pre-created: a glob's static prefix as a
  directory, a literal path as an empty file unless something is
  already there; a grant outside the project (`~/…`, absolute) only
  when it is a glob.

## Tests

`tests/sandbox*.unsafe.test.ts` (the sandbox cannot nest, so the CI
job runs them with `VX_REQUIRE_SANDBOX=1`); `tests/execute-task*.test.ts`
for the request shape.
