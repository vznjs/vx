# `src/workspace/config-cache.ts` — config evaluation cache

## Purpose

Skip re-evaluating a `vx.config` whose result cannot have changed. A
config is a program; evaluating a thousand of them is the largest fixed
cost of a warm run (2026-09-02, synthetic 1000-project workspace: ~80 ms
to import the modules, ~12 ms to read the same files as data). The cache
stores the **validated** config as JSON in `cache.db` (`config_evals`),
and `loadProjectConfig` serves a hit without importing the module.

## Key

`configEvalKey({ configPath, bytes, workspaceFingerprint })` folds, in
order: `CONFIG_EVAL_VERSION`, `Bun.version`, the workspace fingerprint
(lockfiles — covers package imports), then for the config and every file
it transitively imports by **relative** specifier: the path and the
bytes. Editing a shared preset the config imports moves the key even
though the config's own bytes did not change.

## Purity gate

The key is `null` — evaluate live, store nothing — unless the whole
closure is provably pure:

- every import is relative, or exactly `@vzn/vx` (whose `defineProject`
  / `defineWorkspace` are identity functions);
- no relative import resolves into `node_modules` (a workspace symlink
  can move without the lockfile moving);
- the closure has ≤ 32 files;
- with string literals and comments removed (`stripLiterals`), no file
  mentions a global through which the environment can leak: `process`,
  `Bun`, `globalThis`, `fetch`, `Date`, `Intl`, `crypto`, `performance`,
  `navigator`, `require`, `eval`, `Function`, `await`, `toLocale*`,
  `import.meta`, `Math.random`, or a dynamic `import(`.

`stripLiterals` refuses (returns `null`) on any `/` outside a comment: a
regex literal can contain a quote, and a lexer that misread one would
swallow real code as a string — a false SAFE, the one outcome this
module must never produce. The gate fails safe in every direction: a
false negative costs one evaluation, never a stale key.

## Invariants

- A hit is served **unvalidated**: only validated configs are stored.
- JSON is already the contract for a config object (`hashTaskConfig` and
  `vx lock` go through `JSON.stringify`), so a cached config derives the
  same task cache key as a live evaluation of the same bytes.
- `fresh: true` (what `vx lock` / `vx show` use) bypasses the cache in
  both directions.
- The store honours the run's local read/write axes: `--cache=local:`
  neither reads nor writes it.
- Rows unused for 30 days are pruned on `Cache.close()`.

## Tests

`tests/config-cache.test.ts`: key stability and closure sensitivity, the
allowed-import set, each impurity token, impurity inside an imported
file, the literal stripper (strings, templates, comments, the slash
bail-out), the served-from-store proof (a store row replaced under the
same key is what the loader returns), and the read/write axes.
