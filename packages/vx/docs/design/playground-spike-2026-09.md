# The playground spike (2026-09-23, item 676, roadmap W9)

W9 is the playground: vx's real planner running in the browser over a
workspace the reader edits ([site-teaches](site-teaches-2026-09.md#order-and-size),
item 8). Before any widget depends on it, the spike answers two questions:

1. Can the planner modules be bundled for the browser behind a small
   platform shim?
2. Does the bundle produce the same task graph and cache keys as the CLI?

The spike's code lived in `packages/vx-bench/playground-spike/`. Nothing
in `packages/vx/src` changed. Since item 695 the bundle's parts are the
site's: the entry, the shim and the fixture are
`packages/vx-docs/src/playground/`, `packages/vx-docs/scripts/build-playground.ts`
builds them, and the spike's comparisons are test rows (see
[Shipped](#shipped-item-695)). The measurement tools stay in
`packages/vx-bench/playground-spike/` and import the site's files.

## Verdict: feasible, with changes

Yes to both questions, on the spike's fixture. The bundle runs core's own
source, unchanged, behind a shim of about 10 KB minified (12 KB with the
entry). Its graph and keys are
identical to `vx run --dry=json`.

Four things stand between the spike and W9:

- a small core refactor that takes the local store out of the bundle (P1);
- an exact port of Bun's glob matcher (the spike's matcher agreed on every
  realistic glob, but not on every adversarial one; done as item 692);
- a way to evaluate a config the reader types (done as item 699);
- a decision about one finding in core: Bun's `xxHash3` ignores the high
  32 bits of its seed, so the key chain carries 32 bits between steps.

## Evidence

All numbers are from Bun 1.4.2 on Linux x64.

### The bundle

The build (the spike's `build.ts`, now `buildPlayground()` in
`packages/vx-docs/scripts/build-playground.ts`) calls
`Bun.build({ target: 'browser', minify: true })`, the JS form of
`bun build --target=browser`. The JS form is needed for the aliasing
plugin.

| Build                                          | Raw     | Gzip   |
| ---------------------------------------------- | ------- | ------ |
| As spiked (borrows `Cache.prototype.key`)      | 126,846 | 43,085 |
| Borrow removed (measured), the size P1 reaches | 76,519  | 27,408 |
| After P1 (item 691), `foldKey` imported        | 78,465  | 27,972 |
| After the exact glob port (item 692)           | 81,370  | 28,666 |
| Pure stubs, one inlined export (item 695)      | 79,811  | 28,154 |

About 50 KB of the spiked bundle is the local store. That is
`src/cache/cache.ts` (26 KB) with the archive, tar, zstd, output-index,
run-history, config-eval and file-hash modules it imports. The bundle
keeps it only because the spike borrows the key fold from the `Cache`
class, and the class keeps its imports alive. The fold itself is about
2 KB. The largest remaining parts are the config schema (12 KB, needed:
the playground validates what the reader writes), the task graph (5 KB),
the scheduler (5 KB), input resolution (5 KB) and Bun's `node:path`
polyfill (4.6 KB).

What the bundle's import graph asks for, and what each gets:

| Specifier                       | Importers (core)                             | Treatment                                                                                 |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `node:path`                     | 25 modules                                   | Bun's browser polyfill                                                                    |
| `node:fs`                       | 14 modules                                   | VFS shim: `lstatSync`, `statSync`, `existsSync`, `readFileSync`; the rest throw           |
| `node:fs/promises`              | 7 modules                                    | VFS shim: `stat`, `lstat`, `readdir` (with file types), `readFile`, `realpath`            |
| `bun:sqlite`                    | `src/cache/cache.ts`                         | stub: `Database` throws; the playground never opens a store                               |
| `node:os`                       | `util/errors.ts`, `util/cgroup.ts`, `exec/*` | link-only stub, never called                                                              |
| `node:module`                   | `workspace/config-imports.ts`                | link-only stub; `builtinModules` inlined at build time, because it is read at module load |
| `@anthropic-ai/sandbox-runtime` | `exec/sandbox-runtime.ts` (dynamic import)   | link-only stub, never called                                                              |

Bun resolves every static and dynamic import before it tree-shakes. So a
module on the graph that the plan never calls still has to link.
`exec/` reaches the graph through `orchestrator/projects.ts`, which
imports the plugin host for the `project` stage; the plugin host imports
the local executor. After tree-shaking, `exec/` contributes 353 bytes.

The build rewrites core's globals with
`define: { Bun: '__vxBun', process: '__vxProcess' }`. The output has no
imports and no free `Bun` or `process` reference: 42 `__vxBun` and 17
`__vxProcess` sites, all pointing at the shim.

### The shim surface

| Need                    | Core's call                                                    | Shim                                                                                             |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| (a) xxh3                | `Bun.hash.xxHash3(input, seed)`                                | `shim/xxh3.ts`: a pure-TS port over BigInt, with Bun's 32-bit seed (3.5 KB)                      |
| (b) glob matching       | `new Bun.Glob(p).match(path)` through `taskGlob`               | `shim/glob.ts`: a port of Bun's `src/glob/matcher.rs` (5.5 KB; the spike's RegExp rules: 2.6 KB) |
| (c) file reads, listing | `Bun.file(p).exists/text/bytes`, `node:fs`, `node:fs/promises` | `shim/vfs.ts` plus two fs modules over it                                                        |
| (d) module-load clock   | `Bun.nanoseconds()` in `src/util/timing.ts`, at load           | `performance.now()`                                                                              |
| (d) environment         | `process.env` (`cache.inputs.env`, and `VX_TIMING` at load)    | a map the reader edits                                                                           |
| (d) platform            | `process.platform` (`listProjects` picks readdir by it)        | `'linux'`                                                                                        |
| (d) warnings            | `process.stderr.write` (discovery, the scheduler)              | `console.warn`                                                                                   |
| (d) git enumeration     | `git ls-files -s` + `git status` in `prepareRun`               | every VFS file tracked and clean, its OID a git blob SHA-1 from Web Crypto                       |
| (d) config evaluation   | `import()` of `vx.config.*` in the loader                      | plain objects, validated by core's `validateProjectConfig`, handed to `loadProjects` as `staged` |
| (d) the cache store     | SQLite                                                         | a set of keys; `key()` is core's fold, borrowed from `Cache.prototype`                           |

The entry (`entry.ts`) is the plan half of `prepareRun`, rebuilt from
core's exported pieces. It calls, in order:

1. discovery: `loadWorkspace` and `listProjects`;
2. `buildPackageGraph`;
3. `loadProjects`, with the configs staged;
4. `expandRequested` and `buildTaskGraph`;
5. `computeWorkspaceFingerprints`;
6. `applyGitEnumeration`;
7. `plan()`;
8. `computeReverseDepCount` and a `runGraph` dispatch.

Only the enumeration, the configs and the store come from the page.

### Browser equals CLI

The spike's `compare.ts`, now the rows of
`packages/vx/tests/playground-parity.unsafe.test.ts`, writes the fixture
(`packages/vx-docs/src/playground/fixture.ts`) to a temporary git
repository. The fixture has five projects:

- a `^build` chain and a `pkg#task` edge;
- inputs with a negation, braces and a literal `[id]` route directory;
- `outputs.files` and one `cache.inputs.env` entry;
- two `workspaceFiles` declarations, one with a negation;
- a task with no cache block and a group task.

For each scenario the script runs the CLI
(`vx run build ci --all --dry=json`, a subprocess) and the bundle's
`planPlayground` over the same files held in memory. While the bundle
runs, the host's `Bun.hash.xxHash3`, `Bun.Glob`, `Bun.file`, `Bun.spawn`,
`Bun.spawnSync`, `Bun.CryptoHasher`, `Bun.nanoseconds`, `Bun.write` and
twelve `node:fs` functions are replaced by traps that count and throw.

| Scenario                        | Tasks | Keys, statuses, deps | Priorities | Dispatch order | Keys moved vs committed                          |
| ------------------------------- | ----- | -------------------- | ---------- | -------------- | ------------------------------------------------ |
| committed tree                  | 8     | identical            | identical  | identical      | none                                             |
| env change (`API_URL`)          | 8     | identical            | identical  | identical      | core build and test, ui build, app build, app ci |
| uncommitted edit in `@pg/utils` | 8     | identical            | identical  | identical      | the above plus utils build                       |

In the third scenario the CLI hashes the dirty file from disk and the
bundle computes the blob from memory. The two OIDs agree.

The controls:

- **Negative control.** The bundle under the wrong `API_URL` differs from
  the committed CLI plan on exactly the five tasks the variable reaches.
- **Traps.** No trap fired.
- **Mutations.** Two mutations of the shim were each caught in all three
  scenarios. One gave xxh3 a full 64-bit seed; the other read `[id]` as a
  class, the pre-667 reading. For the second, the fixture holds
  `app/d/data.json`, which only a class reaches.

The priorities and the dispatch order come from the bundled
`computeReverseDepCount` and `runGraph`. They are compared with core's
source run on the CLI's graph.

Plan latency inside the bundle (`playground-spike/bench.ts`, min and
median):

| Workspace                      | Min     | Median  |
| ------------------------------ | ------- | ------- |
| the fixture (29 files)         | 2.3 ms  | 4.3 ms  |
| 50 projects × 20 files (1,102) | 68.3 ms | 72.7 ms |

### xxh3

The spike's `xxh3-equiv.ts` compared each candidate with
`Bun.hash.xxHash3` on the same inputs (since item 695 the pure-TS port's
two columns and the control are the rows of
`packages/vx-docs/tests/playground-xxh3.test.ts`, and hash-wasm, which no
row needs, left the repo):

- **(i)** 1,000 random inputs covering every length branch (0–16,
  17–128, 129–240, and long inputs across block boundaries). A seventh
  are non-ASCII strings. The seeds are 0, small, 32-bit and 64-bit.
- **(ii)** 200 seed chains shaped like `Cache.key()`, 1–40 parts each.

| Candidate                               | (i) differs | (ii) chains differ | Size, licence                                              |
| --------------------------------------- | ----------- | ------------------ | ---------------------------------------------------------- |
| `shim/xxh3.ts`, with Bun's seed         | 0 / 1,000   | 0 / 200            | 3.5 KB minified; a port of xxHash's BSD-2-Clause reference |
| hash-wasm 4.12.0 `xxhash3`, low seed    | 0 / 1,000   | 0 / 200            | 18 KB UMD; MIT; **async only**                             |
| the reference with the full 64-bit seed | 200 / 1,000 | 200 / 200          | (the control)                                              |

xxhash-wasm has no XXH3 at all, and xxh3-ts has only XXH64 and
XXH3-128. hash-wasm matches, but it can back core's synchronous `xxh3()`
only through a hand-written adapter over its embedded WASM, because its
public API returns a Promise. The pure-TS port needs no adapter. Its
BigInt arithmetic is slow, but at the playground's scale it costs little
(see the latency table).

The 200 control misses are the fifth of inputs whose seed is above 2^32.
`seed-probe.ts` shows why:

- in 500 of 500 samples, two seeds equal in their low 32 bits hash the
  same;
- the reference agrees with Bun only when the seed is masked to 32 bits.

**Bun 1.4.2's `xxHash3` uses only the low 32 bits of the seed.**

### Glob

`playground-spike/glob-equiv.ts` fuzzes against `Bun.Glob.match` as the oracle, with
20,000 patterns × 25 paths per domain. Task globs are compiled by core's
own `taskGlob`, so the escaping under test is core's. "Git paths" are
what the planner matches: non-empty segments with no leading or trailing
`/`.

Differences from Bun, per domain (realistic: 315 pairs; each fuzz
domain: 500,000):

| Matcher                    | Realistic | Task × git | Task × any | Bun alphabet × git | Bun alphabet × any |
| -------------------------- | --------- | ---------- | ---------- | ------------------ | ------------------ |
| rule-based shim (item 676) | 0         | 219        | 154        | 1,469              | 3,090              |
| exact port (item 692)      | 0         | 0          | 0          | 0                  | 0                  |
| picomatch 4.0.3            | 0         | 1,503      | 6,099      | 3,219              | 8,897              |

At five times the size (`GLOB_FUZZ_N=100000`, 2,500,000 pairs per
domain) the port still differs nowhere.

No library matches Bun's semantics. picomatch was run with
`{ dot: true, noextglob: true }`; micromatch shares its engine; minimatch
was not tested.

Bun's matcher shares a backtracking quirk with `glob-match` (Rust, MIT):
`**/*` does not match `a/`, which is glob-match's special case for a
trailing `/`. The two differ elsewhere, though: `{a,}` matches the empty
path in Bun and not in glob-match. A TS port of glob-match 0.2.1 scored
6,058 differences on task globs over any string, against the rule-based
shim's 154.

The rule-based shim's residual cases were all adversarial:

- several `**` runs abutting braces or stars (`**/**/**x`, `{a,}**/**\[`);
- a `**` followed by `?`.

Item 692 replaced it with a line-for-line port of Bun's own matcher.
In Bun 1.4.2 that is Rust, not Zig: `bun_glob::r#match` in
`src/glob/matcher.rs` (tag `bun-v1.4.2`, commit `744846f8`), which
`Glob::r#match` in `src/runtime/api/glob.rs` calls. Its MIT header
credits Devon Govett, glob-match's author, so the shared quirks are
inheritance. The port walks UTF-8 bytes as the Rust does, and keeps the
depth-10 brace stack and the 10,000-branch budget, which the rule-based
shim lacked. It is 5.5 KB of the bundle, against the rules' 2.6 KB.
`packages/vx-docs/tests/playground-glob.test.ts` (item 692's
`tests/glob-port.test.ts` in vx-bench, moved with the shim in item 695)
holds it at zero in all four domains at this seed and size, and pins hand
rows for the shapes above. It needs no repository, so it runs in
`@vzn/vx-docs#test` under the sandbox.

## Proposed core changes (none made)

- **P1. Lift the key fold out of `Cache`.** Move the body of
  `Cache.key()` into a pure function beside `src/cache/layer.ts`, taking
  the input and a `hashFile`; `Cache.key` delegates. This is
  behaviour-neutral, because the fold reads only `hashFile` and the
  `relFor` memo. It drops the spike's `Object.create(Cache.prototype)`
  borrow, and the bundle falls by about 48 KB raw (about 15 KB gzip).
  DONE as item 691: `src/cache/key-fold.ts` holds `foldKey` and
  `CACHE_VERSION`, `entry.ts` calls it, and the bundle measures 78,465
  B raw and 27,972 B gzip with `compare.ts` still equal on every
  scenario.
- **P2. A platform-free plan preparation.** `entry.ts` is 40 lines that
  copy the plan path of `prepareRun`. A copy drifts when `prepareRun`
  gains a stage. If `prepareRun` took its git enumeration, its config
  source and its store as inputs, the playground could call core's own
  sequence. This is the architect's call.
- **P3. `loadProjects` without the executor.** The `project` stage pulls
  in `exec/` through the plugin host. It links but contributes nothing,
  so this is low priority.
- **P4. The 32-bit seed chain.** Every step of `Cache.key()` and of the
  workspace fingerprint passes the previous digest as the seed, and Bun
  keeps 32 bits of it. So once two input sets diverge, their chains stay
  apart only by the 32 bits carried to the next step. Two input sets of
  one task collide with odds of about 2^-32 per pair, not 2^-64. Such a
  collision is a stale hit, the worst failure class, though an unlikely
  one. Two fixes are possible: fold the previous digest into the next
  input as bytes, or chain through two seeded halves. Either changes
  every key, and a key-derivation fix is self-healing (a mass miss, no
  `CACHE_VERSION` bump). Separately, a row should pin Bun's seed
  behaviour, so that a Bun release which changes it goes red rather than
  silently re-keying every cache. DONE as item 682: a birthday search
  reproduced the collision through `Cache.key`, `xxh3` now feeds the
  seed forward (`xxHash3(part, seed) ^ seed`), the row pinning Bun's
  seed read exists, and `CACHE_VERSION` moved to v29 for the notice.
- **P5. A lazy timing origin.** `src/util/timing.ts` calls
  `Bun.nanoseconds()` and reads `process.env` at module load. Taking t0
  on the first `mark` would remove one shim entry. This is optional.

## Architecture for W9

- **The bundle.** SHIPPED as item 695 ([Shipped](#shipped-item-695)).
  Promote the shim and the entry into
  `packages/vx-docs/src/playground/`. A vx task
  (`@vzn/vx-docs#build.playground`) builds it with `Bun.build`, with the
  same aliases and `define`, into the site's static assets. It is built
  with Bun, not with the site's Vite, so the tested artifact is the
  shipped artifact.
- **Loading.** An island in W0's pattern loads the bundle with a dynamic
  `import()` on first interaction. That is about 28 KB gzip after P1, and
  nothing on a page that never opens the playground. Plans take
  milliseconds, so the main thread is fine; a Worker becomes worth it
  above roughly a thousand files.
- **The pin (browser = CLI).** SHIPPED as item 695, in core's unsafe
  suite as decided below, not in a new task. Three rows:
  - `compare.ts` becomes a test: the built bundle in Bun with the host
    APIs trapped, against the CLI's `--dry=json` on the fixture, with
    the scenarios, the negative control and an exact expected set of
    platform calls;
  - `xxh3-equiv.ts` becomes a test;
  - `glob-equiv.ts` becomes a test: done as item 692,
    `tests/glob-port.test.ts`, at zero differences in every domain
    (now `packages/vx-docs/tests/playground-glob.test.ts`).

  The CLI half needs git, and a sandboxed shard has none, so these rows
  live in a task without `exec.sandbox`. A new such task would be the
  third exception in the repo; the decision below puts them in
  `test.bun.unsafe` instead. The rows run on CI's pinned Bun, so a Bun change
  to `xxHash3` or `Glob` fails a row instead of silently desyncing the
  site.

- **Editing configs.** The key folds the evaluated config object, so the
  page must produce the object Bun would. There are two options:
  - accept an object literal only, and parse it rather than evaluate it;
  - strip TypeScript types (sucrase or similar) and `import()` a Blob URL,
    with `@vzn/vx` mapped to a shim whose `defineProject` is the
    identity.

  The second is the real thing, and it needs a parity row of its own over
  TS configs. Choose at the start of W9. Decided below (a
  `vx.config.mjs`, so no type stripping); SHIPPED as item 699
  ([Shipped](#shipped-item-699)).

## W9 decisions (2026-09-24)

The three questions the spike left open are decided. They bind the W9
work that follows.

- **The parity rows live in core's unsafe suite.** No new unsandboxed
  task. `test.bun.unsafe` already runs without a sandbox and with git,
  for the same reason the parity rows need them (the CLI half runs
  `vx run --dry=json` over a fixture repository). The rows build the
  playground bundle from `packages/vx-docs/src/playground/` with
  `Bun.build`, load it in Bun with the host APIs trapped, and compare it
  with the CLI. The unsafe task's inputs already cover the packages its
  laws read, so a playground edit re-keys it. The repo keeps exactly two
  tasks without `exec.sandbox`.
- **The reader edits `vx.config.mjs`, not `vx.config.ts`.** Core loads
  both, and a JavaScript config needs no type stripping, so the page adds
  no dependency. The page rewrites the one import it allows
  (`@vzn/vx`) to a module whose `defineProject` is the identity, and
  evaluates the text as a module from a Blob URL inside a Worker. The
  Worker keeps the reader's code off the page's DOM and bounds a
  runaway loop (the page terminates it after a deadline). The evaluated
  object crosses back as JSON: the worker stringifies it and the page
  parses it. Corrected in item 699: this said structured clone, with a
  function or another value clone refuses reported as an error. The
  CLI's worker path JSON-round-trips a config
  (`src/workspace/config-eval.ts`), and the key folds `JSON.stringify` of
  the task config, so JSON drops exactly what the key never sees, where
  clone keeps an `undefined` property and refuses a function that path
  drops. `vx run`'s first load differs from both on a function: see
  [Shipped (item 699)](#shipped-item-699). A parity row evaluates the
  same text both ways (the CLI's loader and the page's rewrite) and
  requires the same keys.
- **The bundle is built by a vx task with Bun, not by the site's
  Vite.** `@vzn/vx-docs#build.playground` runs `Bun.build` with the
  spike's aliases into `public/playground/`, and the site's `build`
  depends on it. The artifact the parity rows test is the one the site
  ships. The island loads it with a dynamic `import()` on first use.

Order: P1 (item 691), the exact glob port (item 692), then the bundle
and its task with the parity rows (item 695), then config editing, then
the UI. W10 and W11 build on the finished playground.

## Shipped (item 695)

The bundle, its task and the parity rows. No page loads the bundle yet.

- **Where things are.** `packages/vx-docs/src/playground/` holds
  `entry.ts` (`planPlayground`), the shim (`shim/`) and the parity
  fixture (`fixture.ts`), moved from the spike with their history.
  `packages/vx-docs/scripts/build-playground.ts` exports
  `buildPlayground()`, the only copy of the build options, and writes
  `public/playground/planner.js` when run. The measurement tools
  (`bench.ts`, `bundle-report.ts`, which replaced the spike's reporting
  `build.ts`, `seed-probe.ts`, `glob-equiv.ts`, `glob-probe.ts`) stay in
  `packages/vx-bench/playground-spike/` and import the site's files;
  vx-bench's `lint.oxlint` declares that read and keys on those files.
- **The task.** `@vzn/vx-docs#build.playground` runs the script
  sandboxed, reads its own project and `../vx/src/**`, writes
  `public/playground/**`, keys on the script, `src/playground/**` and
  `package.json` (core's source arrives through `install`, item 687), and
  outputs exactly `public/playground/planner.js`. The site's `build`
  depends on it, and astro copies the file into `dist/`. The file is
  gitignored.
- **A fixed name, not a content hash.** The task's output is that one
  name, so a hit restores it and a rebuild never leaves an old hashed
  sibling in `public/` to ship. GitHub Pages serves every file, the pages
  included, with the same short max-age, so a hash buys no long-lived
  caching. The island will import `/vx/playground/planner.js`.
- **The build is deterministic now.** The spike's stubs inlined every
  export whose value was JSON under 20 KB. An export's value is the
  building process's state: `node:module`'s `_cache` is its module cache,
  data in a script and over the limit inside `bun test`, where it became
  a call that tree-shaking keeps. The same sources built 81,370 bytes in
  the task and 81,397 in the site's test. The stubs now inline only
  `node:module`'s `builtinModules`, the one value core reads at load, and
  every other export is a `/* @__PURE__ */` proxy, so unused ones are
  shaken out: 79,811 B raw, 28,154 B gzip.

The rows:

| Row                                                                                                       | Where                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Per scenario: keys, cache statuses and deps equal the CLI's                                               | `packages/vx/tests/playground-parity.unsafe.test.ts` (`test.bun.unsafe`: git, no sandbox) |
| Per scenario: priorities and dispatch order equal core's scheduler on the CLI's graph                     | same                                                                                      |
| Per scenario: exactly the expected keys move, in both planners (0, 5, 6)                                  | same                                                                                      |
| Negative control: the bundle under the wrong `API_URL` differs on exactly the five tasks it reaches       | same                                                                                      |
| No host trap fires; the calls made are exactly `Bun.Glob`, `Bun.file`, `Bun.hash.xxHash3`; the traps fire | same                                                                                      |
| The site ships exactly what `buildPlayground()` builds; no import and no free `Bun` / `process` in it     | `packages/vx-docs/tests/playground-bundle.test.ts` (sandboxed, reads `dist/`)             |
| xxh3: 1,000 inputs and 200 chains equal Bun's; the 64-bit seed misses exactly the 200 high seeds          | `packages/vx-docs/tests/playground-xxh3.test.ts` (sandboxed, no git)                      |
| Glob: four fuzz domains at zero, hand rows                                                                | `packages/vx-docs/tests/playground-glob.test.ts` (sandboxed, no git)                      |

The parity rows build the bundle with `buildPlayground()` and import it
from a temporary file; the CLI runs over the fixture committed to a
temporary repository under a canonical temporary root, with its own
`--cache-dir`. Core's type-check stays its own: the rows import the
site's files by computed path.

`tests/package-boundaries.unsafe.test.ts` resolved nothing: its pattern
matched `../src/`, core's path before it moved under `packages/`, so a
sibling's `src/` could reach `packages/vx/src` unseen. It now resolves
every relative specifier against its file and exempts the playground by
name, and asserts it sees the playground's reach before it asserts no
other.

In Chromium (Playwright, headless, the built site's `astro preview`),
`import('/vx/playground/planner.js')` in a secure context planned the
fixture with all eight keys equal to `vx run --dry=json`'s, the same
dispatch order and no page error.

## Shipped (item 699)

Config editing: the page evaluates a `vx.config.mjs` text the way the
CLI evaluates the file. No page loads the bundle yet.

- **The rewrite.** `rewriteConfigImports(text, vxUrl)` in
  `packages/vx-docs/src/playground/config-eval.ts` points each `@vzn/vx`
  specifier (an import, a re-export or a literal `import()`) at a
  Blob-URL module whose `defineProject` and `defineWorkspace` are the
  identity, as core's are. It refuses every other specifier by name:
  "cannot import 'node:fs': the playground evaluates a config on its own:
  it can import only @vzn/vx". A computed `import()` is refused as such.
  The detection is a small tokenizer, not a pattern. A specifier in a
  comment, a string, a template, a regular expression, a member call
  (`loader.import(…)`), a property named `import`, or `import.meta` is not
  an import. One misreading is pinned: a `/` after `)` is read as a
  division, so a regular expression there (`if (x) /import('a')/.test(s)`)
  is read as code and refused. The refusal is there for its message, not
  as a boundary: from a Blob URL a browser resolves no other specifier
  anyway. The two identity functions are what configs import from
  `@vzn/vx` (the repo's own configs and the site's snippets); a config
  that names another export fails to link, with the engine's message.
- **The evaluation.** `evaluateConfig(text, deadlineMs)` is exported from
  `entry.ts`, so `planner.js` carries it. It returns `{ ok: true, config }`
  or `{ ok: false, error }`. A fresh module Worker, made from a Blob URL,
  imports the rewritten text from a Blob URL, and replies as core's
  worker does: `JSON.stringify` of an object default export, or null.
  For a null the page returns the CLI's message with its own file name:
  "Project config at vx.config.mjs did not export a default object". A
  throw becomes `name: message`. At the deadline the Worker is terminated
  and the error says so. A browser Worker has no `process`, so a config
  that reads `process.env` while it evaluates fails with "ReferenceError:
  process is not defined". The page does not shim `process`: the
  planner's `env` input is what tasks read. Bun's Worker has `process`,
  so no Bun row can pin that; the Chromium probe below did.
- **The fixture is text.** `fixture.ts` exports `CONFIG_TEXTS`, each
  project's `vx.config.mjs` source importing `defineProject` from
  `@vzn/vx`, and `FILES` holds the same text. `CONFIGS`, the evaluated
  objects, is gone. The parity rows and vx-bench's `bench.ts` evaluate
  the texts through the bundle.
- **Size and cost.** 83,873 B raw, 29,654 B gzip (from 79,811 and
  28,154). One evaluation of `@pg/app`'s config in Bun, the Worker's
  start included, takes 1.8 ms at the minimum and 2.5 ms at the median of 30. Plan latency is unchanged: 2.7 ms minimum for the fixture, 69.3 ms
  for 1,102 files.

**What a probe refuted.** The decision this item carried said that the
page, by JSON, drops a function-valued property exactly as the CLI does.
`vx run --dry=json` does not drop it. The CLI's FIRST load of a config
evaluates it in-process and validates the live object, so
`description: () => 'x'` is refused with "tasks.build.description must be
a string". A function as `exec.timeout`, or inside `dependsOn`, is
refused the same way. Only a REPEAT load (`vx watch`, through the worker
in `src/workspace/config-eval.ts`) JSON-round-trips before it validates.
There the same config is accepted, with the property dropped: loaded
twice through `loadProjectConfig` in one process, it was refused and
then accepted. The page matches the repeat path, and a row pins that. No
row claims `vx run` parity for a function-valued property, because it
does not hold. An `undefined` property agrees on every path: the
validator reads it as absent, and the key's JSON drops it. The gap is
inside core too, since `vx watch` accepts a config that `vx run`
refuses. How to close it is open: the page could refuse what JSON would
drop, core's worker path could validate before its round-trip, or both.

The rows:

| Row                                                                                                                                               | Where                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The fixture's five texts, evaluated by the page, plan what the CLI plans (item 695's scenario rows, now fed by `evaluateConfig`)                  | `packages/vx/tests/playground-parity.unsafe.test.ts` (`test.bun.unsafe`: git, no sandbox) |
| Per variant of `@pg/core` (a loop and spreads, `undefined` properties, `dependsOn` from a constant): keys, statuses and deps equal the CLI's      | same                                                                                      |
| Per variant: exactly 0, 0 and 3 keys move, in both planners                                                                                       | same                                                                                      |
| Negative control: the page's config against the CLI's one-field variant (`@pg/core#test`'s command) differs on exactly the three tasks it reaches | same                                                                                      |
| A default export that is a number, or none: the CLI exits 1 with its message, and the page's is the same with its file name                       | same                                                                                      |
| A function-valued or `undefined` property: the page's object is strictly the CLI worker path's (`evaluateConfigFresh`)                            | same                                                                                      |
| `node:fs` and a relative import are refused by name; `while (true) {}` is terminated at a 200 ms deadline                                         | same                                                                                      |
| The evaluations run with the host traps armed, and none fires                                                                                     | same                                                                                      |
| The rewrite: 8 accepted forms rewritten exactly, 11 look-alikes left byte for byte, 13 refusals by name (one the pinned misreading)               | `packages/vx-docs/tests/playground-config-eval.test.ts` (sandboxed)                       |
| The bundle exports exactly `evaluateConfig` and `planPlayground`                                                                                  | `packages/vx-docs/tests/playground-bundle.test.ts`                                        |

The bundle row's import check read the rewrite's own comparisons with
the strings "from" and "import" in the minified text as two specifiers.
It now asks Bun's `Transpiler.scanImports`, and its positive sample holds
that shape.

Differentials, each restored by reverse edit:

| Mutation                                                              | Red                                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The worker posts the object (structured clone), and the page takes it | both worker-path rows: the function gives "DataCloneError: The object can not be cloned.", the `undefined` property is kept              |
| The rewrite skips double-quoted specifiers                            | four rewrite rows: double quotes, no space, the double-quoted side-effect import and `export { … } from`                                 |
| The deadline is never armed                                           | the deadline row, timed out at 5 s                                                                                                       |
| The refusal removed                                                   | the `node:fs` row (Bun imports it: `ok: true`), the relative-import row (Bun's resolve error instead of the refusal) and 12 rewrite rows |
| The negative control's variant identical to the fixture's text        | the control row alone                                                                                                                    |

In Chromium (Playwright's, headless, the built site's `astro preview` on
localhost, a secure context), `import('/vx/playground/planner.js')` then
`evaluateConfig` on each of the fixture's five texts through the Worker
path, then `planPlayground`, gave all eight keys equal to
`vx run build ci --all --dry=json`'s on the committed fixture. The same
page under a wrong `API_URL` differed on exactly the five tasks it
reaches. `while (true) {}` came back after 203 ms with the deadline
error. `node:fs` was refused by name. `process.env` gave "ReferenceError:
process is not defined". A function-valued property came back dropped.
A number default export gave the CLI's message, and a syntax error gave
"SyntaxError: Unexpected end of input". There was no page error.

## Risks

1. **The oracle is Bun's behaviour, not a spec.** The 32-bit seed and
   the glob quirks are Bun's, and a Bun upgrade can change either. The
   parity rows turn that into a red build instead of a wrong page.
2. **Glob residuals.** Closed by item 692: the matcher is a port of
   Bun's, at zero differences on the fuzz. A Bun release that changes its
   matcher reopens this, and `playground-glob.test.ts` goes red when it
   does.
3. **Config evaluation** runs the reader's code in the page. Run it in a
   Worker. Its object must also serialise the way Bun's evaluation does.
4. **Drift of the copied prepare path** (P2), until core exposes it.
5. **What the playground does not model:**
   - plugins (none are bundled; `@vzn/vx-lockfile`'s fingerprint claims
     could be, the same way);
   - `cache.inputs.runtime`, which spawns `sh`, so the page must refuse it
     or simulate it;
   - `.gitignore` and untracked or ignored states: every VFS file counts
     as tracked and clean, so the invisible-literal refusal cannot fire,
     and a W10 lab about ignored files needs ignore evaluation in the VFS;
   - symlinks, the sandbox and execution (outputs and restores are
     simulated).
6. **Web Crypto needs a secure context.** `crypto.subtle` exists only on
   HTTPS or localhost. The site is served over HTTPS.
7. **Scale.** BigInt xxh3 and per-file SHA-1 are fine at playground size
   (1,102 files in 70 ms), not at a real monorepo's.

## Estimate

About six to eight agent days for W9 alone:

| Work                                                                   | Days  |
| ---------------------------------------------------------------------- | ----- |
| P1, with its module doc and a row                                      | 0.5   |
| Bundle in vx-docs, the build task, the lazy island                     | 1     |
| The parity suite (compare, xxh3, glob as rows) in an unsandboxed task  | 0.5–1 |
| An exact glob port, fuzzed to zero                                     | 1     |
| In-page config evaluation, with its parity row                         | 1–1.5 |
| The playground UI: editor, plan view, stepping through hits and misses | 2–3   |

The site plan budgets four to six days for W9 to W12 together. W9 alone
likely spends that whole budget.

## Reproducing

The rows run in the gate: `@vzn/vx#test.bun.unsafe` (parity) and
`@vzn/vx-docs#test` (the shipped bundle, xxh3, glob). The tools, from
`packages/vx-bench` after `bun install`:

```sh
bun playground-spike/bundle-report.ts  # the bundle's sizes, specifiers and bytes per module
bun playground-spike/bench.ts          # plan latency inside the bundle
bun playground-spike/seed-probe.ts     # Bun's 32-bit seed
bun playground-spike/glob-equiv.ts     # the glob fuzz with picomatch (DUMP=n prints n differences)
bun playground-spike/glob-probe.ts '<pattern>' '<path>'   # one Bun.Glob answer
```

`glob-equiv.ts` exits 1 on any difference in any domain
(`GLOB_FUZZ_N=n` sets its size). The rest print.
