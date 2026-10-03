# `src/workspace/project-loader.ts` — config file evaluation

## Purpose

Evaluate a `vx.config.{ts,mts,js,mjs,cts,cjs}` file and return the resolved
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
export async function loadProjectConfig(
  configPath: string,
  opts?: LoadProjectConfigOptions,
): Promise<ProjectConfig>
export async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig | null>

// The batch form every reading verb goes through: one staged evaluation
// for many configs, served from the evaluation cache unless `fresh`.
export interface LoadProjectConfigOptions {
  // Observe the CURRENT environment: no eval cache, even beside `evalCache`.
  fresh?: boolean
  evalCache?: { store: ConfigEvalStore; workspaceRoot?: string; workspaceFingerprint: string }
}
export async function loadProjectConfigs(
  configPaths: readonly string[],
  opts?: LoadProjectConfigOptions,
): Promise<ProjectConfig[]>

// The names a workspace config may take, in resolution order.
export const WORKSPACE_CONFIG_FILENAMES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
  'vx.workspace.cts',
  'vx.workspace.cjs',
]

// A Bun `ResolveMessage` / `BuildMessage` as a one-line UserError naming the
// config (and the file, for a syntax error in an import); null for anything else.
export function configLoadError(err: unknown, configPath: string, kind: string): UserError | null
```

What the evaluated object may contain is `config-schema.ts`'s
business (`validateProjectConfig`, `validateWorkspace`); the loader
calls both after evaluation and re-exports `validateProjectConfig` for
readers that reach it here.

## Loading rules

- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`. Each is handed
  to a native `await import()`. Bun resolves TypeScript natively —
  no transpile step, no separate loader, no `jiti`.
- On a first load the import specifier is
  `<absolutePath>?vx-bust=<xxh3-of-bytes>`, or `?vx-held=` for a
  project config evaluated from the bytes the loader read (below).
  Content changes produce a different query string → different ESM
  module identity → fresh evaluation. Same content → cached module (the
  no-op fast path).
- On a repeat load the path is evaluated in a Worker instead, and the
  resolved object comes back as JSON.
- Configs the cache does not answer load 128 at a time (`LOAD_WIDTH`),
  not one after another: 1,000 cold configs' `load configs` went from
  226 to 164 ms at 64 (D-68), and from 432 to 411 ms at 128 (stream I). Results keep the order they were asked in, a
  failure stops none of the others (their evaluations are stored for the
  next attempt), and the error thrown is the first in that order. A hit
  is taken synchronously, so the warm path is unchanged.
- The default export must be a non-null object. Anything else throws
  `"Project config at <path> did not export a default object"` (a function default export adds `: it exports a function, …`, D-110)
  (`Workspace config at …` for a workspace file) — from
  the same check on both paths.
- Both paths read the same environment: each Worker request carries the
  parent's `process.env` as it is at that moment, and the Worker syncs to
  it before the import. A Worker otherwise starts with the process's
  startup environment, so a config reading a variable the process set
  since saw it on the first load and not on later ones, and an
  embedder's second `run()` derived a different key (D-61).
- What a config prints in the Worker goes to stderr, by every route
  (`console`, `process.stdout.write`, `Bun.write(Bun.stdout)`,
  `Bun.stdout.writer()`): the parent's stdout may be `vx mcp`'s
  JSON-RPC stream, whose own redirect covers only the parent thread, and
  a second tool call's config output landed between two responses
  (D-64). The first load prints where the process's stdout points.
- A config that calls `process.exit` while it evaluates fails the load,
  at the config's line, on both paths: "process.exit(0) in a config: a
  config exports its object; it cannot end the run". In process
  it ended vx mid-load (`exit(0)` was a green run that ran nothing); in
  the Worker it ended the Worker unheard, and the load waited out its
  deadline (D-65). The guard is counted, so concurrent loads leave the
  real `process.exit` in place only once the last has left. An exit a
  config schedules for later (a timer) is not covered.
- A first load may not change the built-ins vx runs on:
  `Object.prototype`, `Array.prototype`, `String`, `Map`, `Set`,
  `Promise`, `RegExp`, `Function`, `Number` and `Date` prototypes,
  `Object`, `Array`, `Reflect`, `Date`, `Bun`, `Bun.hash`, `JSON` and
  `Math`. The check reads through primitives taken before any config runs,
  in indexed loops: a config that set `Reflect.ownKeys = () => []` (or
  `Array.prototype.forEach`) blinded it before, and its
  `Object.prototype.exec` ran in another project's task (D-124; +2 ms on a
  cold 300-config load, none warm). Every
  config is read through them and cache keys are made with them
  (`Bun.hash.xxHash3 = () => 7n` keyed every task 00000000, D-75), and
  the key folds each config's own JSON, so `Object.prototype.exec` set in one config ran in another
  project's task and a cache hit replayed the old command after it
  changed (D-74). Each first load is compared with a snapshot taken
  before its round evaluates anything, before anything reads through
  them (a replaced `Array.prototype.includes` broke the JSON-data walk
  itself); what changed is put back, a failed load's too, and the load
  is refused naming the property. Loads overlap (`LOAD_WIDTH` at a time),
  so the load that sees a change may not be the one that made it: when
  more than one evaluation was in flight, the round evaluates each of its
  configs alone in a throwaway worker that reports what it changed, and
  names the first that changes something (it named an innocent config
  before, D-119); none found, it says "a project config". While loads
  overlap, each one is checked against only the built-ins the loader
  itself reads through between loads (`Object.prototype`, `JSON`, the
  `Promise`, `Map` and `Set` prototypes, `Bun.hash`), and the rest once,
  at the round's end: all of them after every load was ~73 µs a config,
  a quarter of a cold load of 1,000. A change found at the end may have
  broken another config's load, so it is refused first, and a round that
  changed anything stores none of its evaluations. A lone load checks
  them all. A round where every config hits takes
  no snapshot: reading every descriptor of `Bun` builds its lazy
  members, 7 ms of a warm run (E-88).
- A first load may not move the process either: a config's
  `process.chdir()` left every relative path vx resolved after it reading
  from the config's choice; the working directory is put back and the load
  refused, naming `process.cwd (a chdir)` (D-120).
- `vx.workspace.ts` gets the same guard: it runs in this process too, and
  its `Object.prototype.exec` ran in a project's group task. Built-ins,
  `process.env`, the cwd and the umask are snapshotted around its load, put
  back, and the load refused naming the file, a failed load's change
  included (D-126): the workspace config's bytes are in no key, so a
  removed `Object.prototype.exec` replayed the old command. Globals are
  left out: it loads first in every run, filtered or not. Of `Bun` it reads
  the descriptors of the members vx reads (`BUN_MEMBERS_VX_READS`, held to
  every `Bun.<name>` in `src/`) and keeps the rest's keys and order: some
  members are built on their first read (`Bun.postgres` loads `bun:sql`),
  and the full read was 4.4–5 ms of every warm run. A replaced member vx
  does not read is not caught here.
- Nor change the umask: a config's `process.umask(0o777)` left every file
  vx and its tasks wrote after it `000`, a cache artifact a user other than
  root could not read back. A worker shares the process's umask (a
  `chdir` there stays the worker's), so a repeat load is checked too: the
  worker puts it back after every evaluation and the load is refused,
  naming `process.umask` (D-125).
- A first load may not add or replace a global either: one config's
  `globalThis.x = …` reached every config loaded after it in the process,
  so `vx run --all` read it and a `--filter` of the reader alone did not
  (D-122). `globalThis` is watched with the built-ins above: put back,
  refused naming `globalThis.<key>`; a constant configs share goes in a
  module each one imports. Cost: +3 ms on a cold 300-config load, none warm.
  Not covered: first loads share the module registry, so a config that
  mutates an imported module's state is read the same way by the configs
  loaded after it (probed: `--all` read `leaked`, `--filter` of the reader
  `none`). Isolating it would take a worker per config, which D-68 measured
  out; keep shared modules constant.
- A first load may not change `process.env` either: a config that set
  a variable gave it to every project's `passThrough` and to vx's own
  `VX_*` reads, and a repeat load, in a worker, gave it to neither
  (D-76). The same snapshot, compare, put back and refuse; a task gets
  a value through `exec.env.define` or the host's `passThrough`. While
  loads overlap it is compared once, at the round's end, as most
  built-ins are: reading every variable after every load was 15–25 µs a
  config.
- A first load has the Worker's deadline too (`VX_CONFIG_WORKER_TIMEOUT_MS`,
  30 s): a top-level await that never settles fails the load, naming
  the config and the budget, where it hung `vx run` silently (D-66).
  The evaluation itself cannot be cancelled; a timer it left running
  still holds the process open after the run reports. A synchronous
  loop (`while (true) {}`) holds the thread the deadline fires on, so it
  hangs until killed; a repeat load, in its Worker, still fails at the
  budget. Bounding it would take the worker per config D-68 measured out.
- A Promise default export is awaited on both paths, so an async
  config resolves to its object on the first load and in the Worker
  alike (D-5). The awaited value is checked again, a workspace
  config's too (D-6).
- Validation runs on whichever object the two paths produced, so a
  malformed config reports the identical `UserError` either way.
- A value JSON cannot carry (a function, `NaN`, a `Map`, …) is refused
  by both paths with one message (item 701, config-schema.md): the first
  load's `validateProjectConfig` sees the live object, and the Worker
  runs the same `nonJsonPaths`, embedded in its inline source by
  `toString()`, BEFORE its `JSON.stringify` would drop the evidence. It
  replies with the paths instead of the JSON, and `evaluateConfigFresh`
  throws the `UserError`. The compiled binary's Worker is held to it by
  `scripts/check-binary.ts` (`check.binary`).

## Evaluated from the bytes it read

The loader reads a project config's bytes to key it (config-cache.ts)
and to refuse an unprovided import; `import()` then opened and read the
file again. A first load of a project config is now served those bytes
by the `vx-config-bytes` onLoad (`Bun.plugin`), under `?vx-held=`: one
read of the config per run, and the evaluation runs exactly the bytes
the key saw. It is also the cheaper import — 1,000 configs took 80–100
ms served against 180 ms read by Bun, and the cold `load configs` stage
of a 1,000-package `vx run --dry` dropped from 256 to 181 ms (min of 7,
interleaved, 2026-09-24; 100 packages: 51 to 33).

What `onLoad` source cannot be, it is not handed:

- **Only ESM.** Source from `onLoad` is always evaluated as a module;
  a file Bun would run as CommonJS (no `export`, and `module.exports`,
  `exports`, `require`, `this` or `__dirname` at the top) would lose its
  exports. `hasEsmExport` (config-imports.ts) asks Bun's own parser for
  an ESM `export`; without one, the config takes Bun's path, `?vx-bust=`.
- **Only UTF-8.** Bun's loader reads invalid UTF-8 as Latin-1 and a
  decoder would repair it to U+FFFD, a different string; a strict decode
  that fails sends the config down Bun's path. And the source goes over
  as a string: `onLoad` reads a byte array as Latin-1 (a `ü` came back
  `Ã¼`, caught by config-eval's JSON-data row).
- **The query never reaches the user.** A served module's stack frames
  name its specifier, rewritten to the path; a `ResolveMessage` has
  either query stripped.
- **Not the workspace config.** Proving it ESM is the parser's first
  use in a warm run (~0.27 ms) and `loadWorkspaceConfig` measured 0.3 ms
  slower served, so Bun reads it a second time.

A repeat load (the Worker, below) reads the file in the Worker's own
registry; nothing is served there. What stays read twice in a cold run,
and why — the project's `package.json` and directory, which Bun's
resolver visits for the importer whatever vx hands it — is pinned with
strace in `tests/read-once.unsafe.test.ts`.

## Why a Worker on a repeat load

The content-hash bust only changes the **entry's** specifier. Bun caches
an evaluated module by its **resolved** specifier, so an
`import './preset.js'` inside a config resolves to the same key no
matter what query the entry carries — a busted entry re-evaluates
against a **stale preset**.

Shared presets are the documented composition mechanism (`@vzn/vx-migrate`
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

Every path hands out a tree of its own: a cache hit and the lock
parse JSON, and a first in-process load, which yields the module
object, now returns the parse of the JSON it already builds for the
evaluation cache. The module object shares what the source shares — one
preset task imported by two configs, one `exec` in two tasks — so a
`project` hook that edits in place (the way the API invites) edited all
of them at once: a cold run ran `echo P +plug +plug` where the warm run
and `--frozen` ran `echo P +plug`, under another key (item 967). The copy
costs about 1.7 ms per 1,000 configs, and only on the live path.

Two properties make the swap safe:

- **Key stability.** The config crosses back as JSON, which is already
  this project's contract for a config object: `hashTaskConfig` derives
  the cache key from `JSON.stringify(config)` and `vx lock` stores the
  same round-trip. Since `JSON.stringify(JSON.parse(s)) === s`, a config
  re-read through a Worker derives the **same** cache key as the
  in-process first load — which is why this needed no `CACHE_VERSION`
  bump.
- **Round sharing.** A round is one `loadProjectConfigs` call, the path
  `loadProjects` takes for a run and for every watch cycle. It evaluates
  its repeat loads inside `beginEvalRound()`, which
  holds the Worker open until the round ends, so a round costs one
  Worker, not one per project, and the next round still starts from an
  empty registry. Loads in flight at the same moment from separate calls
  also share one. Before item 694 nothing held the round: the in-flight
  count reached zero between configs, so 5 repeat configs made 5 Workers,
  and a 50-config repeat round took 148 ms against 10.5 ms now. Sharing within
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
  cannot cross a Worker boundary at all. A repeat load busts the
  config's own URL, so an edit to `vx.workspace.ts` itself is read, but
  Bun answers what it imports from the registry: `vx mcp` served an
  edited local plugin's first version on every call (item 1046). So a
  repeat load walks the config's relative imports and refuses, naming
  the file, when one changed since the first successful load in this
  process; the fix is a restart, as `vx watch` says when it sees the
  edit. A process that loads once (every CLI verb but these two) pays
  nothing for it.

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
- The served first load (`a project config is evaluated from the bytes
vx read`): a CommonJS config keeps its exports, non-UTF-8 bytes
  evaluate as Bun reads them, and neither a runtime throw's stack nor
  an unresolvable import names the query.

## Replacing this module

Drop in any function that takes an absolute config path and returns
`ProjectConfig`. Alternatives:

- **esbuild / oxc-based loader** — fastest TS evaluation but ships an
  extra dep and gives up Bun's native TS support.
- **Subprocess isolation** — a fresh process per repeat load also gets
  a clean registry, but measured ~30-50 ms against the Worker's
  ~8-15 ms, and a compiled binary cannot spawn `bun` (it would need an
  internal subcommand on `process.execPath`).

Before either evaluation path (the first in-process import, the repeat
load's worker), a bare import nothing above the config provides is refused
with the install named (`refuseUnprovidedImports`, item 239): left to Bun, a
workspace with no `node_modules` would auto-install it from the registry
first, and a config must never download.
