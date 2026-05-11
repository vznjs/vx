# `inputs.ts` — input file + env resolution

## Purpose

Turn a task's declared `cache.inputs` into concrete data the cache key
can hash:
- a sorted list of absolute file paths whose contents will be hashed
- a sorted list of `[envName, hostValue]` pairs

Plus a small helper to resolve `cache.outputs.files` to actual produced
files for capture.

## Public surface

```ts
export interface ResolvedInputs {
  files: string[]                                       // absolute paths, sorted
  envValues: Array<[name: string, value: string]>      // sorted by name
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: CacheInputs | undefined
  ownOutputs: string[]                  // project-relative globs to exclude
  nestedProjectDirs: string[]           // absolute dirs of nested projects
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs>

export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]>
```

## File resolution rules

A glob pass that yields the final `files` list:

1. **Positive entries** — `cache.inputs.files` strings that don't
   start with `!`. If `cache.inputs.files` is undefined (only happens
   for tasks with no `cache` block, where we hash inputs anyway for
   downstream propagation), defaults to `['**/*']`.
2. **Negative entries** — strings starting with `!`. The `!` is
   stripped, and the rest is added to the ignore list.
3. **Always-ignored** — hard-coded list:
   `node_modules/**`, `.git/**`, `.vzn/**`, `*.tsbuildinfo`.
4. **Boundary ignores** — every nested project's directory (relative
   to this project) → `<rel>/**`. Computed by the orchestrator;
   guarantees cross-project isolation.
5. **Own outputs** — declared `cache.outputs.files` are added to the
   ignore set. Prevents self-invalidation.
6. **Gitignore filter** — after globbing, results are filtered through
   `.gitignore` rules from the workspace root and the project dir.

The matched absolute paths are sorted alphabetically and returned.

## Env resolution rules

Listed `cache.inputs.env` names are looked up in `envSource` (the
host's `process.env`):
- Set names → `[name, value]` pair.
- Unset names → `[name, '']` (distinguishable from "name was never
  listed").
- Sorted by name for deterministic key ordering.

## Output resolution rules

`resolveOutputs` is a simpler glob pass:
- Globs run against the project dir.
- Always-ignored paths excluded (`node_modules`, etc.).
- Nested-project subtrees excluded (boundary isolation).
- **No gitignore filter** — outputs like `dist/` are usually
  gitignored on purpose, and we still want to capture them.

Returns sorted absolute paths.

## What this does NOT do

- Doesn't hash file content (that's `cache.ts:hashFiles`).
- Doesn't apply `inputs.tasks` filtering (that's
  `orchestrator.filterUpstreamHashes`).
- Doesn't support workspace-relative globs in `inputs.files` —
  intentionally scoped per-project. For workspace-shared files, see
  the deferred `WorkspaceConfig.globalInputs` in
  [`../schema.md`](../schema.md).
- Doesn't follow symlinks specially.

## Tests

Mostly covered by `orchestrator.test.ts` e2e tests:
- default = all files (gitignore-aware)
- narrow globs limit cache busting
- negation excludes
- self-invalidation guard (declared outputs excluded)
- boundary isolation (nested project files don't leak)
- gitignored files excluded; negated gitignore re-included
- empty `files: []` produces stable hash
- env input value changes bust cache; unset vs empty differ

## Replacing this module

Possible directions:

- **Auto-tracking inputs** (vite-task style) — instead of static
  globs, capture the files the command actually read via syscall
  spying. Replace `resolveFiles` with a strategy that runs the command
  in a tracing wrapper. Significant scope.
- **Cross-project inputs** — add a notion of "this file from that
  project" (e.g., `{ project: 'lib-a', files: '...' }`). Today this is
  expressed only via the `dependsOn` + upstream-hash propagation;
  direct file references across projects are forbidden.
- **Faster hashing** — current implementation reads files sequentially.
  Parallelizing would help on very large input sets.
