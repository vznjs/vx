# The playground spike (2026-09-23, item 676, roadmap W9)

W9 is the playground: vx's real planner running in the browser over a
workspace the reader edits ([site-teaches](site-teaches-2026-09.md#order-and-size),
item 8). Before any widget depends on it, the spike answers two questions:

1. Can the planner modules be bundled for the browser behind a small
   platform shim?
2. Does the bundle produce the same task graph and cache keys as the CLI?

The spike code lives in `packages/vx-bench/playground-spike/`, which is
private and ships in no package. Nothing in `packages/vx/src` changed.

## Verdict: feasible, with changes

Yes to both questions, on the spike's fixture. The bundle runs core's own
source, unchanged, behind a shim of about 10 KB minified (12 KB with the
entry). Its graph and keys are
identical to `vx run --dry=json`.

Four things stand between the spike and W9:

- a small core refactor that takes the local store out of the bundle (P1);
- an exact port of Bun's glob matcher (the spike's matcher agrees on every
  realistic glob, but not yet on every adversarial one);
- a way to evaluate a config the reader types;
- a decision about one finding in core: Bun's `xxHash3` ignores the high
  32 bits of its seed, so the key chain carries 32 bits between steps.

## Evidence

All numbers are from Bun 1.4.2 on Linux x64.

### The bundle

`build.ts` calls `Bun.build({ target: 'browser', minify: true })`, the
JS form of `bun build --target=browser`. The JS form is needed for the
aliasing plugin.

| Build                                          | Raw     | Gzip   |
| ---------------------------------------------- | ------- | ------ |
| As spiked (borrows `Cache.prototype.key`)      | 126,846 | 43,085 |
| Borrow removed (measured), the size P1 reaches | 76,519  | 27,408 |
| After P1 (item 691), `foldKey` imported        | 78,465  | 27,972 |

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
| (b) glob matching       | `new Bun.Glob(p).match(path)` through `taskGlob`               | `shim/glob.ts`: the pattern compiled to one RegExp, by Bun's measured rules (2.6 KB)             |
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

`compare.ts` writes the fixture (`fixture.ts`) to a temporary git
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

Plan latency inside the bundle (`bench.ts`, min and median):

| Workspace                      | Min     | Median  |
| ------------------------------ | ------- | ------- |
| the fixture (29 files)         | 2.3 ms  | 4.3 ms  |
| 50 projects × 20 files (1,102) | 68.3 ms | 72.7 ms |

### xxh3

`xxh3-equiv.ts` compares each candidate with `Bun.hash.xxHash3` on the
same inputs:

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

`glob-equiv.ts` fuzzes against `Bun.Glob.match` as the oracle, with
20,000 patterns × 25 paths per domain. Task globs are compiled by core's
own `taskGlob`, so the escaping under test is core's. "Git paths" are
what the planner matches: non-empty segments with no leading or trailing
`/`.

| Domain                            | Pairs   | Shim differs | picomatch 4.0.3 differs |
| --------------------------------- | ------- | ------------ | ----------------------- |
| realistic globs × realistic paths | 315     | 0            | 0                       |
| task globs × git paths            | 500,000 | 219          | 1,503                   |
| task globs × any string           | 500,000 | 154          | 6,099                   |
| Bun's whole alphabet × git paths  | 500,000 | 1,469        | 3,219                   |

No library matches Bun's semantics. picomatch was run with
`{ dot: true, noextglob: true }`; micromatch shares its engine; minimatch
was not tested.

Bun's matcher shares a backtracking quirk with `glob-match` (Rust, MIT):
`**/*` does not match `a/`, which is glob-match's special case for a
trailing `/`. The two differ elsewhere, though: `{a,}` matches the empty
path in Bun and not in glob-match. A TS port of glob-match 0.2.1 scored
6,058 differences on task globs over any string, against the rule-based
shim's 154.

The shim's residual cases are all adversarial:

- several `**` runs abutting braces or stars (`**/**/**x`, `{a,}**/**\[`);
- a `**` followed by `?`.

The exact route is to port Bun's own matcher (its Zig source, MIT) to
TS, then hold it at zero differences with this fuzz. Bun's source was
not reachable from this session (no GitHub access), so the port is W9
work.

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

## Proposed architecture for W9

- **The bundle.** Promote the shim and the entry into
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
- **The pin (browser = CLI).** Three rows:
  - `compare.ts` becomes a test: the built bundle in Bun with the host
    APIs trapped, against the CLI's `--dry=json` on the fixture, with
    the scenarios, the negative control and an exact expected set of
    platform calls;
  - `xxh3-equiv.ts` becomes a test;
  - `glob-equiv.ts` becomes a test, at zero differences on task globs
    over git paths once the matcher is ported.

  The CLI half needs git, and a sandboxed shard has none, so these rows
  live in a task without `exec.sandbox`. Such a task is the third
  exception in the repo, so it needs the owner's word, or a way for the
  sandbox to host git. The rows run on CI's pinned Bun, so a Bun change
  to `xxHash3` or `Glob` fails a row instead of silently desyncing the
  site.

- **Editing configs.** The key folds the evaluated config object, so the
  page must produce the object Bun would. There are two options:
  - accept an object literal only, and parse it rather than evaluate it;
  - strip TypeScript types (sucrase or similar) and `import()` a Blob URL,
    with `@vzn/vx` mapped to a shim whose `defineProject` is the
    identity.

  The second is the real thing, and it needs a parity row of its own over
  TS configs. Choose at the start of W9.

## Risks

1. **The oracle is Bun's behaviour, not a spec.** The 32-bit seed and
   the glob quirks are Bun's, and a Bun upgrade can change either. The
   parity rows turn that into a red build instead of a wrong page.
2. **Glob residuals.** Until the matcher is an exact port, a reader who
   types an adversarial glob can get a plan the CLI would not make. The
   page can refuse globs outside the fuzz-proven shapes until then.
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

From `packages/vx-bench`, after `bun install`:

```sh
bun playground-spike/build.ts        # the bundle, its sizes and specifiers → dist/ (ignored)
bun playground-spike/compare.ts      # browser = CLI; SPIKE_TMP=<dir> for the fixture repo
bun playground-spike/bench.ts        # plan latency inside the bundle
bun playground-spike/xxh3-equiv.ts   # the three xxh3 candidates
bun playground-spike/seed-probe.ts   # Bun's 32-bit seed
bun playground-spike/glob-equiv.ts   # the glob fuzz (DUMP=n prints n differences)
bun playground-spike/glob-probe.ts '<pattern>' '<path>'   # one Bun.Glob answer
```

Each script exits 1 when its claim fails. The exceptions are
`glob-equiv.ts`, which fails only on the realistic table (the fuzz
domains are a scoreboard), and the two probes, which only print.
