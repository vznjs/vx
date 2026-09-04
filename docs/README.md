# `@vzn/vx` — technical documentation

vx is a task runner and content-addressed build cache for JavaScript
monorepos, built Bun-native. It runs your task graph in parallel,
caches every result by content, and replays work it has already done.

That description fits several tools. What follows is the part that
doesn't: the problems vx treats as the hard ones, and what it actually
does about each.

## The problems

### 1. A cache that returns the wrong answer

Every other failure degrades. This one lies. A stale hit replays bytes
from a build whose inputs no longer exist, under a green checkmark, and
nothing downstream can tell. It is the only bug class where "the build
passed" is the symptom.

Most of vx's design is a response to this:

- **The config is evaluated, then hashed.** Your `vx.config.ts` is a
  TypeScript program. A tool that hashes the config _file_ misses the
  preset it imported, the constant it computed, the environment it
  read. vx hashes the resolved object, so imports participate in cache
  identity. ([caching.md](./caching.md))
- **Declared outputs are wiped before execution AND before restore.**
  The tree ends every run byte-identical to the artifact — no
  survivor from a previous build masquerading as output.
- **Upstream identity is folded in by INPUT, not output.** A
  dependency's key cascades to its dependents, so a change anywhere
  upstream re-keys everything downstream, without making a task's key
  depend on bytes that were produced non-deterministically.

### 2. Nobody can tell you why it re-ran

A cache key is one opaque hash. When it changes, the tool says "miss"
and you guess. vx persists the per-component input fingerprint for
every entry, so `vx why <task>` names the exact component that moved —
this file, that env var, that upstream — rather than the fact that
something did. ([cli.md](./cli.md#vx-why))

### 3. Knowing what to run is a different question from knowing what changed

`--affected` maps changed files to projects. That mapping has holes
that are easy to miss and expensive to hit: a shared preset that no
project _owns_, a config that imports a file from another package. If
input hashing can see a change, selection has to see it too, or CI
runs nothing and reports success. vx routes changed files to projects
through three channels — directory containment, declared
`workspaceFiles` globs, and a static scan of what each config
**imports**. ([modules/affected.md](./modules/affected.md))

### 4. Boundaries that hold under pressure

A project's globs never reach into another project's directory. Inputs
are declared, never inferred — vx deliberately does not trace
filesystem reads, because an explicit input set is a correctness
property. A task that wants its reads confined to the set it declared
asks for that with `sandbox`.

### 5. Doing all that without becoming the platform

Core is a pipeline with a hook at every stage — `project` (a project's
tasks), `graph` (the edges), `key` (extra key material), `schedule`
(which ready task runs first), `executor` (where one task's command
runs), `cache` (where artifacts live), `telemetry` (where run records
go), `commands` (which verbs exist) — and applies **none** of them by
default. Even vx's own local executor and local cache are plugins you
declare. A workspace that declares none fails before any task runs,
naming the fix. Nothing here is a first-party product you have to adopt
to get the good behaviour, and nothing distributed ships in this repo —
the hooks are how it gets built.
([modules/plugin.md](./modules/plugin.md), the design in
[design/pipeline-2026-09.md](./design/pipeline-2026-09.md), and the
"Extending vx" guides on the docs site)

## What that buys, measured

Numbers come from `bench/` and are reproducible; the invariant behind
each is recorded in [optimizations.md](./optimizations.md).

- A fully-cached run on a 100-project workspace completes in **79 ms**
  wall-clock; on 476 packages / 1,428 tasks in **297 ms**, where
  Turborepo 2.10 takes 342 ms and Nx 23 takes 1.38 s on the identical
  workspace — and restoring every output is 1.5× faster than Turbo
  ([benchmarks.md](./benchmarks.md), 2026-09).
- At 15k input files, deriving every cache key costs **zero file reads**
  — hashes come from git's index for tracked, clean files.
- No daemon. Nothing to keep warm, nothing to restart.

## Adopt it in two minutes

```bash
bun add -d @vzn/vx
# …or globally, as the prebuilt standalone binary:
npm install -g @vzn/vx
```

Drop a `vx.config.ts` next to any workspace package:

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      // Cache-input env vars must ALSO be passed through — the child
      // env is isolated, and a key that varies on a var the task
      // can't see is incoherent.
      exec: { command: 'tsc -p .', env: { passThrough: ['NODE_ENV'] } },
      cache: {
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'bun test' },
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
    dev: {
      exec: { command: 'vite', timeout: 30_000, persistent: { readyWhen: 'Local:' } },
    },
  },
})
```

Declare what runs it — core applies nothing by default (`vx migrate`
emits this file):

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({ plugins: [localExecutorPlugin(), localCachePlugin()] })
```

Run things:

```bash
vx run build                    # current package (+ its dependency graph)
vx run build test --all         # every package, shared graph
vx run build --filter "@app/*"  # pnpm-style filters
vx run test --affected          # only what changed vs the base branch
vx watch dev                    # re-run on file change
vx run build --dry              # predicted hits/misses, no execution
vx why app#build                # what changed the key last time
vx last                         # replay the previous run's summary
vx cache prune --older-than 7d --max-size 5gb
```

Remote caching is plugin-driven: a `cache` plugin fills core's
`RemoteCacheLayer` seam. [`@vzn/vx-reapi`](../packages/vx-reapi) speaks
Bazel's ActionCache + CAS, so NativeLink / BuildBuddy / Buildbarn /
bazel-remote all work — and the same package can run tasks **on** those
servers via the `executor` seam. Any other store implements the same
seam in a plugin.

## Where to start

| You want to…                               | Read                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| The pitch: what vx does that others don't  | [`comparison.md` § Where vx is ahead](./comparison.md#where-vx-is-ahead) |
| Understand the overall shape               | [`architecture.md`](./architecture.md)                                   |
| Author a `vx.config.ts`                    | [`schema.md`](./schema.md)                                               |
| Reason about caching                       | [`caching.md`](./caching.md)                                             |
| Trace what `vx run` actually does          | [`execution.md`](./execution.md)                                         |
| See each scenario as a diagram             | [`flows.md`](./flows.md)                                                 |
| See every perf decision + invariant        | [`optimizations.md`](./optimizations.md)                                 |
| Use the CLI from a shell                   | [`cli.md`](./cli.md)                                                     |
| Write a plugin / replace a seam            | [`modules/plugin.md`](./modules/plugin.md)                               |
| Benchmarks + side-by-side vs other runners | [`benchmarks.md`](./benchmarks.md), [`comparison.md`](./comparison.md)   |
| Modify, fork, or replace a module          | [`modules/`](./modules/) (one page per source module)                    |
| Read forward-looking design notes          | [`design/`](./design/)                                                   |

If you have ten minutes: read `comparison.md` § Where vx is ahead, then
`architecture.md`. Together they cover the why and the shape.

## Repository layout

A Bun-workspaces monorepo. The root member is core `@vzn/vx`; the
plugins that ship alongside it live under `packages/`.

Core `src/` is **eight modules** — each directory's `index.ts` is its
contract, and cross-module imports go through it only, enforced by
`tests/module-boundaries.test.ts`:

| Module          | Owns                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `cli/`          | subcommand parsers, help, plan formatting                                      |
| `orchestrator/` | run composition: discover → graph → schedule → execute → record                |
| `workspace/`    | project discovery, filters, `--affected`, the lockfile                         |
| `graph/`        | the task graph and the two-tier scheduler                                      |
| `cache/`        | the local store, the layering, the `RemoteCacheLayer` seam                     |
| `exec/`         | per-task execution primitives (spawn, env, sandbox)                            |
| `plugins/`      | core's own local executor + local cache, each importing core as a plugin would |
| `util/`         | small shared helpers                                                           |

Every source file has a page under [`modules/`](./modules/). Tests live
in `tests/`. The plugin packages are `@vzn/vx-reapi` (Bazel remote cache

- remote execution), `@vzn/vx-otel` (OpenTelemetry traces and metrics)
  and `@vzn/vx-github` (job summary + Checks API), each importing core
  only through the public `@vzn/vx` specifier — a boundary the test suite
  enforces.
