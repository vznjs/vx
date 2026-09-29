# A Rust rewrite — feasibility

> **Recommendation: stay on Bun/TypeScript.** Do not rewrite, and do
> not add a native addon now. Rust wins clearly on process startup
> (3.5 ms against 46 ms for the compiled vx binary) and 1.5–6× on the
> compute inside the hot stages. But on a warm 150-project run those
> stages are a minority of a 160 ms wall. The rest is git spawns, SQLite,
> task processes and config evaluation, and a Rust core still needs a JS
> engine for the last one. The rewrite costs about 2–3 person-years and
> reopens the stale-hit failure class. Two cheaper TS-side leads come out
> of the profile instead (§ What to do instead).

> **Status:** research (2026-09-29). Nothing here changes the product.
> Paths are relative to `packages/vx/`.

## Setup

- Container: 4 vCPU, Linux 6.18. Rust 1.94.1 (release, `lto = true`,
  `codegen-units = 1`).
- Bun **1.3.11**, below `engines.bun`. This session could not put 1.4.2
  on PATH. On 1.3.11, `db.close(true)` throws `database is locked` at the
  end of every run, and the throw also stops the timing table from
  printing. The profile therefore ran from a scratch worktree with that
  one call changed to `db.close()`. Nothing in the patch touches the
  stages measured. The absolute Bun numbers may shift on 1.4.2; the
  ratios below are wide enough that the conclusion should not.
- Workloads:
  - `ws`: `packages/vx-bench/generate.ts` with 150 projects, one input
    file each.
  - `ws2`: `ws` with 40 more ~2.7 KB files per project, 6,000 input
    files in all.
- A/B method: arms interleaved in each round, min of 5 rounds, same
  machine, same inputs.

## Where the Bun wall goes

Warm no-op, `vx run build --all`, 150 projects, all hits:

| form                           | wall min (7 reps) |
| ------------------------------ | ----------------: |
| `bun src/bin.ts` (source)      |          242.6 ms |
| compiled binary (`--bytecode`) |          158.9 ms |

`VX_TIMING=1` stage table, compiled binary (own time per stage):

| stage             |  own | what it is                                          |
| ----------------- | ---: | --------------------------------------------------- |
| before the table  |  ~35 | Bun runtime init + evaluating the 238-module bundle |
| startup           | 15.0 | imports ahead of `prepareRun`                       |
| workspace config  | 19.7 | `vx.workspace.mjs` (declares no plugin)             |
| discover projects |  6.6 |                                                     |
| package graph     |  2.3 |                                                     |
| open cache        |  3.7 | SQLite open + workspace fingerprints                |
| load configs      | 13.5 | 150 configs, served from the evaluation cache       |
| git enumeration   |  3.0 | own share; the spawn overlaps earlier stages        |
| build graph       |  0.8 |                                                     |
| classify + probe  | 31.0 | stable keys (xxh3 fold) + one batched SQLite probe  |
| run graph         | 14.3 | 150 restores (output stats)                         |
| record history    |  9.5 | SQLite writes                                       |
| close             |  5.9 |                                                     |

Cold run on the same tree: 822–849 ms, after a first run of 1,075 ms.
Most of that is 150 `sh -c 'mkdir … && cp …'` task processes on 4
workers (`run graph` 556 ms). The save spans (`save: pack`, `save: scan`
and `save: write temp`) overlap across workers, so their totals are not
costs (CLAUDE.md). An isolated one-file save costs 0.82 ms.

## Prototype: the same work in Rust

The probe lived in a scratch directory and is not committed. It is a
147-line Rust binary (dependencies: `xxhash-rust`, `zstd`, `crc32fast`,
`rusqlite` bundled) plus a 79-line Bun twin. The twin calls vx's own
`foldKey`, `planArtifact` + `packArtifactBytes` and `Bun.zstdCompress`.
Both halves do the same two jobs:

- **keys.** Two git spawns: `ls-files -s -z` and
  `status --porcelain -z --untracked-files=no`. Then each project's
  `src/**` is matched against the index, vx's seed-chained xxh3 fold
  runs over every input, and one batched `SELECT … IN (…)` probes
  SQLite. Parity is exact: both halves produce the same 150 keys on both
  workloads (XOR `ebe7eba8ba2cee89` on `ws`, `4aeee85d1be6c278` on
  `ws2`). vx's `xxh3(s, seed)` is `xxh3_64_with_seed(s, seed & 0xffffffff) ^ seed`
  in Rust, because Bun reads only 32 bits of the seed (item 682).
- **pack.** A ustar of `stdout`, every file under the directory, the
  `.vx-meta.json` sidecar and the crc32 `.vx-sum` entry, compressed with
  zstd level 3. Output sizes match within 1% (224 vs 237 bytes;
  649,210 vs 648,513 bytes).

In-process time per operation, min of 5 interleaved rounds:

| job                              |     Bun |    Rust | Rust gain |
| -------------------------------- | ------: | ------: | --------: |
| keys, `ws` (150 files)           |  6.7 ms |  6.1 ms |      1.1× |
| keys, `ws2` (6,000 files)        | 24.8 ms | 15.6 ms |      1.6× |
| pack, one small file             | 0.34 ms | 0.05 ms |      6.5× |
| pack, `src/` (149 files, 2.4 MB) | 20.4 ms | 15.7 ms |      1.3× |

Whole-process wall, one operation, min of 5:

| job          | `bun twin.ts` | Rust binary |
| ------------ | ------------: | ----------: |
| keys, `ws2`  |       70.3 ms |     18.3 ms |
| pack, `src/` |       69.3 ms |     21.9 ms |

Process startup, min of 10 (two interleaved passes agreed within 0.5 ms):

| binary                           |    min |
| -------------------------------- | -----: |
| Rust hello world (436 KB)        | 3.3 ms |
| compiled Bun hello world (99 MB) |  12 ms |
| `bun -e 0`                       |  14 ms |
| compiled vx `--version` (110 MB) |  46 ms |
| `bun src/bin.ts --version`       |  86 ms |

What the numbers say:

- **git dominates `keys`.** The two spawns alone take 5.4 + 8.2 ms on
  `ws2` and 3.9 + 4.8 ms on `ws`. Rust runs them one after the other
  and Bun overlaps them, so the 1.6× gain on `ws2` understates Rust's
  fold. It is still only about 9 ms per 6,000 input files, about
  1.5 µs per file.
- **pack's large case is zstd.** Both sides call the same C library.
  Rust's 6.5× win is on the small artifact, which is JS fixed cost:
  0.29 ms of CPU per artifact, or about 11 ms of wall over 150
  artifacts on 4 workers.
- **Startup is the one large, unconditional win.** Bun's runtime floor
  is 12 ms, which an embedded JS engine would pay again. vx's own module
  graph adds another ~34 ms to every invocation, and that is TS-side
  cost.

## What a warm run would save

This is a projection from the stage table, not a measurement. It
assumes a Rust core with no JS on the warm path:

- Startup: −40 ms.
- Stable keys and probe: −15 to −20 ms, from the fold ratio above.
- The rest stays the same: git spawns, SQLite I/O, the output stats,
  and history writes.

The estimate is 159 ms → roughly 80–100 ms. It holds only while no JS
runs. A workspace that declares any plugin, or whose config-evaluation
cache misses, pays for a JS engine again: Bun's 12 ms floor plus
evaluation, or an embedded engine's own start. On the cold run, task
processes dominate. Rust saves the pack fixed cost (~11 ms on this run)
and nothing on the spawns.

## The full rewrite

### Config evaluation (`vx.config.ts` is a program)

Configs import presets, `@vzn/vx` (`defineProject`) and npm packages,
and they are TypeScript.

- **Embed V8 (`deno_core`).** It is fast and has snapshot starts. It
  still needs TS transpilation (oxc or swc), a Node-style resolver and
  enough of the Node/Bun API for real configs. It adds about 30 MB to
  the binary and a V8 build to every release target.
- **QuickJS or Boa.** Starts in under 1 ms, but has no JIT, no TS, no
  resolver and no npm compatibility. A config that imports a CJS preset
  or calls `Bun.*` breaks. That makes it a new, narrower config language.
- **Shell out to Bun on a config-cache miss.** This keeps full
  compatibility and fits vx's existing evaluation cache (`load configs`
  above was served from it). A miss pays Bun's startup, and a warm hit
  pays nothing. This is the only option that does not change what a
  config may say.

### Plugins

The plugin seams are the product (`config` … `telemetry`, `commands`).
Seven plugin packages are JS objects built with `definePlugin`:
`vx-reapi`, `vx-otel`, `vx-github`, `vx-mcp`, `vx-migrate`,
`vx-lockfile` and `vx-schedule-history`. Together they are about 19k
source lines and 31k test lines. Their hooks are called per task
(`executor`, `cache`, `key`, `admit`, `telemetry`).

A Rust core either:

- **Hosts a JS plugin process and makes every seam an IPC protocol.**
  That is a serialised call per task per hook, and a `cache` or
  `executor` plugin streams artifacts across it. It also means a second
  runtime in every run that declares a plugin, which gives the startup
  win back.
- **Rewrites the plugins in Rust.** That ends "a plugin is an npm
  package", and with it the ecosystem story in the direction
  (`@vzn/vx-reapi` as proof the seam is wide enough for anyone).

`vx-migrate`'s Nx path already needs Node (`nx-exec.cjs`), and it would
stay JS whichever way the core goes.

### Sandbox

`exec/sandbox-*.ts` drives bwrap/socat/strace on Linux and seatbelt on
macOS through `@anthropic-ai/sandbox-runtime`, an npm dependency. A Rust
core has to reimplement that runtime's policy generation, proxying and
violation reporting (about 4–6 person-weeks and the whole sandbox law
suite again), or keep calling it through a JS helper. The second choice
is one more process on the task path.

### Other surfaces

- The site's playground bundles core's planner for the browser
  (`vx-docs/src/playground/`, held by `tests/playground-parity.unsafe.test.ts`).
  A Rust core has to ship it as WASM.
- `src/index.ts` is a programmatic API that embedders import, and it
  becomes an N-API binding.

### Test suite

Core has 338 test files and 129k lines. Across all packages there are
6,286 `it`/`test` cases. 238 of core's test files import `../src`, so
they test internals and must be rewritten. Only 53 drive the CLI alone
and could run against a Rust binary unchanged. The mutation-sweep
record (`docs/design/mutation-sweeps-2026-09.md`) would need redoing
against the new code: the suite's strength is measured, not assumed.

### Effort

| part                                                      | person-weeks |
| --------------------------------------------------------- | -----------: |
| core (49.6k TS source lines → Rust)                       |        40–60 |
| core tests (238 internal files; 129k lines)               |        30–50 |
| config evaluation (Bun subprocess + protocol, or V8)      |         6–12 |
| plugin host protocol + porting 7 plugins' suites          |        15–25 |
| sandbox runtime                                           |          4–6 |
| playground WASM, N-API façade, release matrix (4 targets) |         6–10 |
| **total**                                                 | **~100–160** |

These rates assume a careful port: parity-checked, with the stale-hit
laws re-proven. They are not greenfield rates.

### Risk and downsides

- **Cache correctness is the worst failure class, and a port re-derives
  it.** About 1,000 numbered items of fixes live in the TS code and its
  tests, and every one is a place the port can regress silently. A
  stale hit replays wrong bytes under a green run.
- The binary shrinks from 110 MB to a few MB without a JS engine, but
  JS comes back with any plugin or config-cache miss.
- The plugin story, the programmatic API and the playground each become
  a boundary (IPC, N-API, WASM) where today they are one language.
- Contributors need Rust and TS. "No build step" ends: cargo builds per
  target, plus V8 if embedded.
- Development stops for 2–3 person-years while Turbo and Nx keep moving.
  vx already leads the warm column (STATUS § Decisions, item 756).

## Hybrids

- **Rust addon (N-API or `bun:ffi`) for fold and pack.** The per-call
  work is microseconds, so the fold must cross the FFI boundary once per
  task (or once per run), never once per xxh3. The ceiling is the
  prototype's gap: about 9 ms per 6,000 inputs and 0.29 ms CPU per small
  artifact. The costs:
  - a native build for 4 targets, which ends "no build step";
  - a `.so` or `.dylib` embedded in the compiled binary;
  - a second implementation of the key fold that must stay bit-identical
    to the first (parity was easy here, and it must hold forever);
  - `Bun.zstd*` is already native, so the large pack gains little.

  Not worth it at 150–1,000 projects. Revisit if a real repo's profile
  shows fold or pack above ~15% of warm wall.

- **Rust CLI shim.** A small front binary that answers `--version` and
  `help` and execs Bun for everything else. A real run then pays both
  startups. It gains something only if the shim can answer a warm no-op
  itself, which means persisting and verifying stable keys outside JS.
  That is item 756's deferred design, plus a second key implementation.
  Rejected for the same reason 756 was deferred: a digest that misses an
  input is a stale hit on every run.
- **Rust core, Bun for configs and plugins.** This is the full rewrite
  above minus V8. It keeps the whole effort and adds the IPC boundary.

## What to do instead (TS-side leads, not measured here)

1. **Module-graph startup.** The compiled `vx --version` takes 46 ms,
   against 12 ms for a compiled Bun hello world. Those ~34 ms are vx's
   own bundle evaluation, and every invocation pays them. Lazy-loading verbs and
   heavy modules behind the verb that needs them is the cheapest large
   win in this report: about the same size as the whole Rust
   compute gain.
2. **`workspace config` is 19.7 ms for a workspace that declares no
   plugin.** Evaluating an empty `vx.workspace.mjs` should cost about
   1 ms, so something else is loading in that stage. Profile it with
   `bun --cpu-prof` before assuming a cause.

## Reproduce

- Generate the workspace: `bun packages/vx-bench/generate.ts <dir> 150`.
- Build the compiled binary with the release command from
  `vx.config.ts` (`bun build --compile --no-compile-autoload-dotenv --minify --bytecode src/bin.ts`).
- Take the stage table with `VX_TIMING=1 <vx> run build --all`, warm.
- The probe's fold is vx's `foldKey` field order for a task with no
  env, upstream or runtime inputs:
  1. `CACHE_VERSION`
  2. `task:<id>`
  3. `workspace:wf`
  4. `pkg:`
  5. `config:c`
  6. `forward-args:0`
  7. `env-values:0`
  8. `runtime-values:0`
  9. `ws-runtime-values:0`
  10. `upstream:0`
  11. `inputs:<n>`
  12. one `path\0oid` per sorted input
