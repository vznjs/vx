# `src/workspace/config-cache.ts` — config evaluation cache

## Purpose

Skip re-evaluating a `vx.config` whose result cannot have changed. A
config is a program; evaluating a thousand of them is the largest fixed
cost of a warm run (2026-09-02, synthetic 1000-project workspace: ~80 ms
to import the modules, ~12 ms to read the same files as data). The cache
stores the **validated** config as JSON in `cache.db` (`config_evals`),
and `loadProjectConfig` serves a hit without importing the module.
`prepareRun` loads each round of configs through `loadProjectConfigs`,
which reads every file's bytes and key in parallel and asks the store ONCE
(`ConfigEvalStore.getConfigEvals`, optional; `Cache` answers with one `IN`
query per 900 keys — 1,000 point lookups measured 3.6 ms against 0.7 for
the batch), then evaluates only the misses in the order given, so a failure
names the first broken file as a one-by-one load did, and writes what the
round learned ONCE at the end (`putConfigEvals` / `putConfigClosures`, one
transaction each; a per-config put was one autocommit transaction each, and
1,000 of them cost 180–240 ms against 2.5 — item 615). The slow path keys a
closure file from the bytes it read to scan it (`hashBytes`), not through
the stat memo: the memo row it wrote was a third autocommit per file, and
the first warm load builds the memo in one transaction instead.

## Public surface

```ts
export const CONFIG_EVAL_VERSION = 3

/** Where cached evaluations live; `Cache` implements it over `cache.db`. */
export interface ConfigEvalStore {
  hashFile?(file: string): Promise<string> // the warm fast path: a file's git blob id behind a stat memo
  hashFiles?(files: readonly string[]): Promise<Map<string, string>> // the same over many paths, one memo query per 500
  hashBytes?(bytes: Uint8Array, nearPath: string): string // hashFile's identity from the bytes: the slow path's, no memo row
  getConfigClosures?(configPaths: readonly string[]): Map<string, string[]>
  putConfigClosure?(configPath: string, files: readonly string[]): void
  putConfigClosures?(entries: ReadonlyArray<readonly [string, readonly string[]]>): void // a round's closures, one transaction
  getConfigEval(key: string): string | null
  getConfigEvals?(keys: readonly string[]): Map<string, string> // many keys in one round-trip
  putConfigEval(key: string, json: string): void
  putConfigEvals?(entries: ReadonlyArray<readonly [string, string]>): void // a round's evaluations, one transaction
}

/** What `configEvalKey` learned besides the key, for the store's closure index. */
export interface ConfigEvalKeyResult {
  key: string
  closure: string[] // the config first, then every relative import in discovery order
  indexable: boolean // false when a relative import is extensionless
}

export interface ConfigEvalKeyArgs {
  configPath: string
  hashBytes?: (bytes: Uint8Array, nearPath: string) => string // the identity from the bytes in hand; preferred over hashFile
  hashFile?: (file: string) => Promise<string> // absent too: the blob id is computed from the bytes in-process
  bytes: Uint8Array
  workspaceFingerprint: string
}

export function stripLiterals(source: string): string | null
export function blobOidOf(bytes: Uint8Array): string
export async function configEvalKey(a: ConfigEvalKeyArgs): Promise<ConfigEvalKeyResult | null>
export async function configEvalKeyFromClosure(a: {
  configPath: string
  closure: readonly string[]
  hashFile: (file: string) => Promise<string>
  workspaceFingerprint: string
}): Promise<string | null>
```

## Key

`configEvalKey({ configPath, bytes, workspaceFingerprint })` folds, in
order: `CONFIG_EVAL_VERSION` (3 since 2026-09-24, item 701: an evaluation cached before configs had to be JSON data may hold what JSON made of a `Map` or a hole, which the rule now refuses; 2 since 2026-09-03: the key folds each closure file's git blob id, not its bytes), `Bun.version`, the workspace fingerprint
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
  `Bun`, `globalThis`, `global`, `self` (Bun's two live aliases of
  `globalThis` — a computed `global['proc' + 'ess']` never spells
  `process`), `fetch`, `Date`, `Temporal`, `Intl`, `crypto`,
  `performance`, `navigator`, `require`, `eval`, `Function`,
  `constructor`, `localeCompare` (a locale is the environment too),
  `await`, `toLocale*`, `import.meta`, `Math.random`, or a dynamic
  `import(`;
- no backslash survives in code position: outside literals that is an
  identifier escape, and `\u0070rocess` IS `process` while matching no
  word in the list. Every spelling in the last two rules was cached as
  pure before it was listed (2026-09-03).

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
- `fresh: true` (what `vx lock` uses) bypasses the cache in both
  directions, even when an `evalCache` is passed beside it.
- The store honours the run's local read/write axes: `--cache=local:`
  neither reads nor writes it.
- Rows unused for 30 days are pruned on `Cache.close()`.

## Tests

`tests/config-cache.test.ts`: key stability and closure sensitivity, the
allowed-import set, each impurity token, impurity inside an imported
file, the literal stripper (strings, templates, comments, the slash
bail-out), the served-from-store proof (a store row replaced under the
same key is what the loader returns), the read/write axes, the batched
round (one lookup serves the hit and evaluates the miss; two broken
configs name the first in the given order), and the warm fast path (a
load served from the indexed closure with nothing evaluated, a preset
edit that misses through the fast key, an extensionless import never
indexed) — with the mutations that fold only the config or drop the
extension rule each failing exactly their pin.

## The warm fast path (2026-09-03)

Reading and scanning 1,000 configs to key them cost 15 ms on a warm run;
stat-hashing them costs 5. The store (`Cache`) keeps each config's
**ordered closure** — the config first, then every relative import in
discovery order — in `config_closures`, written whenever the slow path
keys a config whose relative imports all carry an explicit extension.
On the next load, `loadProjectConfigs` keys such a config from per-file
identities alone (`Cache.hashFile`: the git blob id behind an
mtime/size/ctime/inode memo — no read, no scan; a file changed within
`FILE_HASH_RACY_MS` of its stat is hashed but not memoised, so a config
edited moments ago is never served from a stale identity) with
`configEvalKeyFromClosure`, whose fold is byte-identical to
`configEvalKey`'s, so the two paths share entries. Every indexed
closure's files are identified in one call (`hashFiles`, one memo query
per 500 paths; 1,000 point reads cost 7.7 ms of a warm run, 2026-09-09).
A fast key that misses takes the slow path for that config, which
re-indexes it.

Sound because closure membership can only change by editing a listed file
(the config, or an import that gains or drops an import), which changes
that file's identity and so the key. The one exception is an
**extensionless** relative import: a new file could change what it
resolves to without touching any listed file, so such a config is served
by the slow path and never indexed (`indexable: false`). Both directions
are pinned in `tests/config-cache.test.ts`; the mutations that fold only
the config, or drop the extension rule, each fail exactly their pin.
