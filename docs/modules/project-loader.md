# `project-loader.ts` — config file evaluation

## Purpose

Evaluate a `vx.config.{ts,mts,js,mjs}` file and return the resolved
`ProjectConfig` object. Handle TypeScript via `jiti`; handle native
ES modules via dynamic `import()` with mtime cache-busting so config
edits show up across calls within the same Node process.

## Public surface

```ts
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig>
```

## Loading rules

- `.ts`, `.mts`, `.cts` → `jiti.import()` with `moduleCache: false`.
  Each call transforms the file fresh and evaluates it.
- `.mjs`, `.js`, `.cjs` → native `import()`. The URL is
  `pathToFileURL(configPath)` with a `?mtime=<mtime_ms>` query string.
  Different mtime → different URL → different ESM module identity →
  fresh evaluation. Same mtime → cached module.

The default export must be a non-null object. Anything else throws
`"Project config at <path> did not export a default object"`.

## Why mtime cache-busting

Node's ESM loader caches modules by URL. Without a cache-busting
parameter, the second `import()` of the same path inside one process
returns the _first_ loaded module, even after the file changed on
disk. With `?mtime=<ms>`, file edits produce a different URL, forcing
re-evaluation.

This matters when:

- Tests run multiple `vx run` calls in the same process and edit
  configs between them.
- (Future) a long-running watch mode reloads configs after edits.

For the normal one-shot `vx run` CLI invocation it doesn't matter
(each invocation is a fresh Node process), but supporting it costs
nothing.

## What this does NOT do

- Doesn't validate the config against the schema beyond "is it an
  object?". Schema mismatches surface later as TypeScript errors at
  build time, or as runtime errors deep in the orchestrator.
- Doesn't sandbox the evaluated config — config code runs with the
  caller's full Node permissions. The user wrote it, the user trusts it.
- Doesn't transform imports — relative imports inside the config
  resolve normally via jiti or Node's loader. Including from
  `node_modules`. This is what enables presets.

## Caveats consumers should know

- **Side effects in config files run every load.** Authors writing
  `process.env.SET_AT_LOAD_TIME = 'oops'` will see that env mutation.
- **`Date.now()` in config = always-different configHash.** Resolved
  values get baked into the object, including non-deterministic ones.
  This is a footgun documented in `architecture.md`.
- **Imports from `node_modules` are cached by Node, not by us.**
  Within one Node process, an `import from 'pkg'` resolves once and
  doesn't reload even if `node_modules` updates. Fine for CLI use;
  matters if we add a daemon.

## Tests

`project-loader.test.ts` covers:

- Loads a default-exported object from `.mjs`.
- Throws on no-default export.
- Throws on non-object default export.

## Replacing this module

Drop in any function that takes an absolute config path and returns
`ProjectConfig`. Alternatives:

- **Native node `import()` with `--experimental-strip-types`** —
  removes the `jiti` dependency. Currently still experimental in some
  Node versions; revisit when stable.
- **esbuild / oxc-based loader** — faster TS evaluation, more deps.
- **Worker-based isolation** — load configs in a worker thread for
  better cleanup / cache invalidation in long-running processes.

Make sure the replacement honors `interopDefault` (treat
`module.exports = x` and `export default x` equivalently).
