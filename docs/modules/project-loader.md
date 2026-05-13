# `src/workspace/project-loader.ts` — config file evaluation

## Purpose

Evaluate a `vx.config.{ts,mts,js,mjs}` file and return the resolved
`ProjectConfig` object. Bun runs TypeScript natively, so the loader is
a thin wrapper around `await import()` with a content-hash query-string
bust to invalidate ESM module cache when the config changes.

## Public surface

```ts
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig>
export async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig | null>
```

## Loading rules

- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`. Each is handed
  to a native `await import()`. Bun resolves TypeScript natively —
  no transpile step, no separate loader, no `jiti`.
- The import specifier is `<absolutePath>?vx-bust=<sha256-of-bytes>`.
  Content changes produce a different query string → different ESM
  module identity → fresh evaluation. Same content → cached module
  (the no-op fast path).
- The default export must be a non-null object. Anything else throws
  `"Project config at <path> did not export a default object"`.

## Why content-hash cache-busting

Bun's ESM loader (like Node's) caches modules by URL. Without a
cache-busting parameter, the second `import()` of the same path inside
one process returns the _first_ loaded module, even after the file
changed on disk. With `?vx-bust=<sha>`, a byte-level change produces a
different URL, forcing re-evaluation. mtime-based busting was an
earlier approach; we moved to content hashes because Bun's `stat()`
sometimes reports `mtimeNs: undefined`, and content hash is what the
cache key already needs anyway.

This matters when:

- Tests run multiple `vx run` calls in the same process and edit
  configs between them.
- (Future) a long-running watch mode reloads configs after edits.

For the normal one-shot `vx run` CLI invocation it doesn't strictly
matter (each invocation is a fresh Bun process), but supporting it
costs nothing.

## What this does NOT do

- Validates each `TaskConfig` shape at load time and surfaces
  `UserError` on malformed input. Rules enforced:
  - `exec` must be an object with a non-empty `command` string.
  - `exec.persistent` rejects malformed shapes; non-string
    `readyWhen` is rejected.
  - `cache` + `persistent` together is a hard error (no exit to
    cache).
  - A task with no `exec` MUST declare `dependsOn` (group task) —
    a no-op task is rejected.
  - `cache` requires `exec` AND requires both `inputs.files` and
    `outputs.files` arrays.
  - `dependsOn` must be a `string[]`.
  - `description` must be a string.
- Doesn't sandbox the evaluated config — config code runs with the
  caller's full Bun permissions. The user wrote it, the user trusts it.
- Doesn't transform imports — relative imports inside the config
  resolve normally via Bun's loader. Including from `node_modules`.
  This is what enables presets.

## Caveats consumers should know

- **Side effects in config files run every load.** Authors writing
  `process.env.SET_AT_LOAD_TIME = 'oops'` will see that env mutation.
- **`Date.now()` in config = always-different configHash.** Resolved
  values get baked into the object, including non-deterministic ones.
  This is a footgun documented in `architecture.md`.
- **Imports from `node_modules` are cached by Bun, not by us.**
  Within one Bun process, an `import from 'pkg'` resolves once and
  doesn't reload even if `node_modules` updates. Fine for CLI use;
  matters if we add a daemon.

## Tests

`tests/project-loader.test.ts` covers:

- Loads a default-exported object from `.mjs`.
- Throws on no-default export.
- Throws on non-object default export.
- Group-task validation (accepts task with only `dependsOn`; rejects
  task with neither `exec` nor `dependsOn`; rejects `cache` on a
  group task).
- `loadWorkspaceConfig` returns null when no `vx.workspace.*` file
  exists, validates `concurrency` and `cacheDir`.

## Replacing this module

Drop in any function that takes an absolute config path and returns
`ProjectConfig`. Alternatives:

- **esbuild / oxc-based loader** — fastest TS evaluation but ships an
  extra dep and gives up Bun's native TS support.
- **Worker-based isolation** — load configs in a worker thread for
  better cleanup / cache invalidation in long-running processes.
