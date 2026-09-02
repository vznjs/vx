# `src/workspace/project-loader.ts` — config file evaluation

## Purpose

Evaluate a `vx.config.{ts,mts,js,mjs}` file and return the resolved
`ProjectConfig` object. Bun runs TypeScript natively, so the loader is
a thin wrapper around `await import()`.

Two paths, chosen by whether this process has loaded that path before:

- **First load** — in-process `await import()` with a content-hash
  query-string bust. The single `vx run` hot path only ever takes this
  one, so it costs exactly what it always did.
- **Repeat load** — re-evaluated in a Worker (`config-eval.ts`),
  because the bust cannot reach the config's import closure.

## Public surface

```ts
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig>
export async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig | null>
```

## Loading rules

- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`. Each is handed
  to a native `await import()`. Bun resolves TypeScript natively —
  no transpile step, no separate loader, no `jiti`.
- On a first load the import specifier is
  `<absolutePath>?vx-bust=<xxh3-of-bytes>`. Content changes produce a
  different query string → different ESM module identity → fresh
  evaluation. Same content → cached module (the no-op fast path).
- On a repeat load the path is evaluated in a Worker instead, and the
  resolved object comes back as JSON.
- The default export must be a non-null object. Anything else throws
  `"Project config at <path> did not export a default object"` — from
  the same check on both paths.
- Validation runs on whichever object the two paths produced, so a
  malformed config reports the identical `UserError` either way.

## Why a Worker on a repeat load

The content-hash bust only changes the **entry's** specifier. Bun caches
an evaluated module by its **resolved** specifier, so an
`import './preset.js'` inside a config resolves to the same key no
matter what query the entry carries — a busted entry re-evaluates
against a **stale preset**.

Shared presets are the documented composition mechanism (`vx migrate`
generates a `vx-preset.ts`), so through a whole `vx watch` session a
preset edit was invisible; and because the resolved config feeds the
cache key, vx answered `up-to-date` for a command that had changed on
disk — a stale cache hit.

A Worker gets its own module registry, so everything it imports is read
from disk now. It is the only mechanism for this that the runtime
exposes as public API: `globalThis.Loader.registry` — the obvious place
to evict from — exists on Bun 1.3.11 and is **gone** on 1.3.14, where an
eviction-based fix degrades to no fix at all while still reporting
success.

Two properties make the swap safe:

- **Key stability.** The config crosses back as JSON, which is already
  this project's contract for a config object: `hashTaskConfig` derives
  the cache key from `JSON.stringify(config)` and `vx lock` stores the
  same round-trip. Since `JSON.stringify(JSON.parse(s)) === s`, a config
  re-read through a Worker derives the **same** cache key as the
  in-process first load — which is why this needed no `CACHE_VERSION`
  bump.
- **Round sharing.** Loads that are in flight at the same moment share
  one Worker, retired when the last settles. A `Promise.all` round (what
  `prepareRun` does) therefore costs one Worker, not one per project,
  and the next round still starts from an empty registry. Sharing within
  a round is also the more faithful semantics: two configs importing the
  same preset evaluate it once, exactly as in a fresh `vx run` process.

The Worker source is an inline `data:` URL rather than a sibling file
because `bun build --compile` does **not** embed a Worker entry point —
it resolves the URL from disk at runtime, so a sibling file would make
the shipped standalone binary fail with `ModuleNotFound`.

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
- **Imports from `node_modules` are cached by Bun on a first load.**
  Within one Bun process an `import from 'pkg'` resolves once; a repeat
  load re-resolves it in a fresh Worker registry.
- **`loadWorkspaceConfig` has no Worker path.** `vx.workspace.ts`
  declares `plugins`, which are objects holding **functions** — they
  cannot cross a Worker boundary at all. So a `vx.workspace.ts` import
  closure can still go stale in a long-lived process. Nothing there
  feeds a cache key (it carries `concurrency`, `cacheDir`, `timeout`,
  `plugins`), so this cannot produce a stale hit; a
  workspace-config edit still needs a restart to take effect.

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
- **Subprocess isolation** — a fresh process per repeat load also gets
  a clean registry, but measured ~30-50 ms against the Worker's
  ~8-15 ms, and a compiled binary cannot spawn `bun` (it would need an
  internal subcommand on `process.execPath`).
