# A Rust rewrite — feasibility

> **Recommendation: stay on Bun/TypeScript.** Do not rewrite, and do
> not add a native addon now. Rust wins clearly on process startup
> (3.3 ms against 19 ms for the compiled vx binary) and on the fixed
> cost of packing a small artifact (6×). On key derivation it is only
> 1.2× faster, and on a 150-file workspace Bun is slightly ahead. On a
> warm 150-project run the stages Rust would speed up are a minority of
> a 101 ms wall. The rest is git spawns, SQLite, task processes and
> config evaluation, and a Rust core still needs a JS engine for the
> last one. The rewrite costs about 2–3 person-years and reopens the
> stale-hit failure class. One cheaper TS-side lead comes out of the
> profile instead (§ What to do instead).

> **Status:** research (2026-09-29). Nothing here changes the product.
> Paths are relative to `packages/vx/`.

## Setup

- Container: 4 vCPU, Linux 6.18.
- Bun 1.4.2, the latest release and CI's pin.
- Rust 1.94.1 (release, `lto = true`, `codegen-units = 1`).
- Workloads:
  - `ws`: `packages/vx-bench/generate.ts` with 150 projects, one input
    file each.
  - `ws2`: `ws` with 40 more ~2.7 KB files per project, 6,000 input
    files in all.
- A/B method: arms interleaved in each round, min of 5 rounds, same
  machine, same inputs.

A first pass ran on Bun 1.3.11, which is below `engines.bun`. That
container's Bun was older than the floor. The 1.3.11 numbers were worse
across the board: the warm run took 159 ms and `vx --version` took
46 ms. They also invented a lead, 20 ms of `workspace config`, that is
8 ms on 1.4.2. Every number below is 1.4.2.

## Where the Bun wall goes

Warm no-op, `vx run build --all`, 150 projects, all hits:

| form                           | wall min (7 reps) |
| ------------------------------ | ----------------: |
| `bun src/bin.ts` (source)      |          190.3 ms |
| compiled binary (`--bytecode`) |          101.1 ms |

`VX_TIMING=1` stage table, compiled binary (own time per stage, ms):

| stage             |  own | what it is                                         |
| ----------------- | ---: | -------------------------------------------------- |
| startup           |  9.8 | imports ahead of `prepareRun`                      |
| workspace config  |  8.1 | `vx.workspace.mjs` (declares no plugin)            |
| discover projects |  3.3 |                                                    |
| package graph     |  1.9 |                                                    |
| open cache        |  2.7 | SQLite open + workspace fingerprints               |
| load configs      | 13.9 | 150 configs, served from the evaluation cache      |
| git enumeration   |  3.7 | own share; the spawn overlaps earlier stages       |
| build graph       |  0.7 |                                                    |
| classify + probe  | 32.1 | stable keys (xxh3 fold) + one batched SQLite probe |
| run graph         | 14.0 | 150 restores (output stats)                        |
| record history    |  4.1 | SQLite writes                                      |
| close             |  5.3 |                                                    |

The table starts when vx's timing module loads. Bun's own start and the
bundle's evaluation come before that point, and `vx --version` below
measures them.

Cold run on the same tree: 633–666 ms. Most of that is 150
`sh -c 'mkdir … && cp …'` task processes on 4 workers (`run graph`
417 ms). The save spans overlap across workers, so their totals are not
costs (CLAUDE.md).

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
  zstd level 3. Output sizes match within 1%.

In-process time per operation, min of 5 interleaved rounds:

| job                              |     Bun |    Rust | Rust gain |
| -------------------------------- | ------: | ------: | --------: |
| keys, `ws` (150 files)           |  5.5 ms |  5.9 ms |     0.94× |
| keys, `ws2` (6,000 files)        | 18.4 ms | 15.4 ms |      1.2× |
| pack, one small file             | 0.33 ms | 0.05 ms |        6× |
| pack, `src/` (149 files, 2.4 MB) | 20.9 ms | 15.8 ms |      1.3× |

Whole-process wall, one operation, min of 5:

| job          | `bun twin.ts` | Rust binary |
| ------------ | ------------: | ----------: |
| keys, `ws2`  |       42.9 ms |     18.9 ms |
| pack, `src/` |       45.8 ms |     20.6 ms |

Process startup, min of 10 (two interleaved passes agreed within 2 ms):

| binary                           |    min |
| -------------------------------- | -----: |
| Rust hello world (436 KB)        | 3.3 ms |
| `bun -e 0`                       | 6.4 ms |
| compiled Bun hello world (81 MB) | 6.6 ms |
| compiled vx `--version` (88 MB)  |  19 ms |
| `bun src/bin.ts --version`       |  56 ms |

What the numbers say:

- **git dominates `keys`.** Rust runs the two spawns one after the
  other and Bun overlaps them. That is why Bun wins on `ws` and why the
  1.2× on `ws2` understates Rust's fold alone. The fold difference is
  still only about 3 ms per 6,000 input files.
- **pack's large case is zstd.** Both sides call the same C library.
  Rust's 6× win is on the small artifact, which is JS fixed cost:
  0.27 ms of CPU per artifact, or about 10 ms of wall over 150
  artifacts on 4 workers.
- **Startup is the one clear, unconditional win: about 16 ms per
  invocation.** Bun's runtime floor is 6.6 ms, and an embedded JS engine
  would pay a similar cost again. vx's own module graph adds another
  ~13 ms, and that is TS-side cost.

## What a warm run would save

This is a projection from the stage table, not a measurement. It
assumes a Rust core with no JS on the warm path:

- Startup: −16 ms.
- Stable keys and probe: −5 to −10 ms, generous given the fold ratio
  above.
- The rest stays the same: git spawns, SQLite I/O, the output stats,
  and history writes.

The estimate is 101 ms → roughly 75–85 ms. It holds only while no JS
runs. A workspace that declares any plugin, or whose config-evaluation
cache misses, pays for a JS engine again: Bun's 6.6 ms floor plus
evaluation, or an embedded engine's own start. On the cold run, task
processes dominate. Rust saves the pack fixed cost (~10 ms on this run)
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
- The binary shrinks from 88 MB to a few MB without a JS engine, but JS
  comes back with any plugin or config-cache miss.
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
  prototype's gap: about 3 ms per 6,000 inputs and 0.27 ms CPU per small
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

## What to do instead (TS-side lead, not measured here)

**Module-graph startup.** The compiled `vx --version` takes 19 ms,
against 6.6 ms for a compiled Bun hello world. Those ~13 ms are vx's own
bundle evaluation, and every invocation pays them. Lazy-loading verbs
and heavy modules behind the verb that needs them could recover most of
the startup gap a Rust rewrite would close, at a fraction of the cost.

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
