# Architecture

## Module map

Each file under `src/` is one focused module. Internal imports are
unidirectional: lower modules in this map don't depend on higher ones.

```
                       ┌────────────────┐
                       │     bin.ts     │  binary entry — wires process.argv
                       └────────┬───────┘
                                │
                       ┌────────▼───────┐
                       │     cli.ts     │  argv parsing + command dispatch
                       └────────┬───────┘
                                │
                       ┌────────▼───────┐
                       │ orchestrator.ts│  end-to-end glue
                       └────────┬───────┘
              ┌─────────────────┼─────────────────────────────┐
              │                 │                             │
       ┌──────▼─────┐    ┌──────▼──────┐    ┌─────────────────▼─────────────────┐
       │ scheduler  │    │ task-graph  │    │       task lifecycle              │
       └────────────┘    └──────┬──────┘    │ ┌────────────┐  ┌─────────────┐   │
                                │           │ │ inputs.ts  │  │ env.ts      │   │
                         ┌──────▼───────┐   │ ├────────────┤  ├─────────────┤   │
                         │ package-graph│   │ │ runner.ts  │  │ sandbox.ts  │   │
                         └──────┬───────┘   │ └────────────┘  └─────────────┘   │
                                │           │ ┌────────────────────────────┐    │
                         ┌──────▼───────┐   │ │           cache            │    │
                         │  workspace   │   │ │ ┌──────────────────────┐   │    │
                         └──────┬───────┘   │ │ │ cache.ts (local v10) │   │    │
                                │           │ │ ├──────────────────────┤   │    │
                         ┌──────▼───────┐   │ │ │ layered-cache.ts     │   │    │
                         │project-loader│   │ │ ├──────────────────────┤   │    │
                         └──────────────┘   │ │ │ remote-cache.ts      │   │    │
                                            │ │ ├──────────────────────┤   │    │
                                            │ │ │ cache-archive.ts     │   │    │
                                            │ │ └──────────────────────┘   │    │
                                            │ └────────────────────────────┘    │
                                            └───────────────────────────────────┘

       config.ts:  the public schema; imported by nearly everything.
       paths.ts:   tiny POSIX-path helper for stable cache keys.
       filter.ts:  pnpm-style filter DSL used by the CLI's -F flag.
       index.ts:   re-exports the public surface.
```

### The cache cluster

The cache is no longer a single file. `cache.ts` is the **local v10
cache** (SQLite index + on-disk outputs). `remote-cache.ts` speaks
the Turborepo `/v8/artifacts/` wire. `cache-archive.ts` bridges them
with tar.gz pack/unpack. `layered-cache.ts` composes local + remote
behind the same surface `Cache` exposes.

The orchestrator constructs the local cache, then conditionally wraps
it in a `LayeredCache` when `VZN_REMOTE_CACHE_URL` + `_TOKEN` are set.
From there, `executeTask` calls the same `key / get / save / restoreOutputs`
methods regardless of the layering.

### The runner / sandbox split

`runner.ts` spawns the user's `exec.command` directly. `sandbox.ts`
wraps the same command in `bwrap` (Linux) or `sandbox-exec` (macOS)
so undeclared file reads return `ENOENT`. The orchestrator picks
between them based on the `--sandbox` flag on `vzn run`.

## Data flow on `vzn run <task>`

1. **`cli.ts`** parses argv → `{ task, projects?, concurrency?,
noCache?, ignoreDependsOn?, sandbox?, forwardArgs? }`. The CLI
   resolves the selection mode (cwd, `-r`, `-F` filters, or
   `pkg#task`) into a concrete project list before invoking the
   orchestrator.
2. **`orchestrator.ts:run()`** is invoked with those options.
3. **`workspace.ts`** walks up to the nearest `pnpm-workspace.yaml`,
   parses it, and lists every package that has a `vzn.config.*` file.
   Detects duplicate package names and throws.
4. **`project-loader.ts`** evaluates each `vzn.config.ts` (or .mjs)
   via `jiti` (`moduleCache: false`, `interopDefault: false`) so
   edits across same-process calls are picked up and missing default
   exports produce a clear error.
5. **`package-graph.ts`** builds the workspace dependency graph from
   each project's `package.json`. Only workspace-internal deps count.
6. **`task-graph.ts`** builds the task graph: starting from the user's
   requested `(project, task)` pairs, it walks each task's
   `dependsOn` into a DAG. Cycles are detected upfront.
7. The orchestrator constructs the cache:
   - `new Cache(.vzn/cache)` — local v10 SQLite + on-disk outputs.
   - If `VZN_REMOTE_CACHE_URL` and `VZN_REMOTE_CACHE_TOKEN` are set,
     wraps it in `new LayeredCache(local, new RemoteCache({...}))`.
   - Either way, the orchestrator sees the `Cache | LayeredCache`
     surface and doesn't branch on the layering.
8. The orchestrator computes a **workspace fingerprint** (hash of
   `pnpm-lock.yaml` + `pnpm-workspace.yaml`) — used in every task's
   cache key.
9. **`scheduler.ts`** receives the task graph and an
   `execute(node, upstream)` callback. It walks the graph
   topologically, running up to `concurrency` tasks at a time. When a
   task fails, its dependents are marked `skipped` but unrelated
   tasks continue.
10. For each task, the orchestrator's `executeTask`:
    - Resolves inputs (**`inputs.ts`**): files (gitignore-aware, with
      declared outputs and nested-project files excluded), env values
      (`cache.inputs.env`).
    - Computes a `taskConfigHash` (sha256 of `JSON.stringify(config)`),
      capturing imported / computed config values.
    - Asks the cache layer for a key from those inputs + the workspace
      fingerprint + filtered upstream cache hashes + any `forwardArgs`.
    - On hit: restores output files, replays captured stdout/stderr,
      returns `cache-hit`.
    - On miss: builds an isolated env (**`env.ts`**) and calls either
      **`runner.runCommand`** (default) or **`sandbox.runSandboxed`**
      (when `--sandbox` is set). On success, captures output files
      and writes the cache entry. On failure, nothing is cached.
11. After all tasks finish, the orchestrator records one row per task
    to the local cache's `runs` table (drives `vzn stats` and
    eviction heuristics). When the layered cache is active, the
    save also fires off a background upload to the remote.

## Replaceability contract

Every module is structured so swapping it requires changes only to
that module's `.ts` file and its consumers' imports.

| Module              | What you'd replace to…                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| `workspace.ts`      | Support yarn/npm workspaces, lerna, or custom layouts                              |
| `project-loader.ts` | Use a different config evaluator (esbuild, swc, native node)                       |
| `cache.ts`          | Change the local-cache storage (e.g., back to per-entry manifests, or fully async) |
| `remote-cache.ts`   | Target a different remote backend (raw S3, custom binary protocol)                 |
| `cache-archive.ts`  | Swap tar.gz for zstd or zip; or use a JS implementation                            |
| `layered-cache.ts`  | Different layering topology (local → regional → global)                            |
| `runner.ts`         | Run inside containers, remote machines                                             |
| `sandbox.ts`        | Use a different sandbox primitive (landlock, Job Objects)                          |
| `scheduler.ts`      | Implement work-stealing, priority queues                                           |
| `inputs.ts`         | Add fspy-style runtime input tracking                                              |
| `env.ts`            | Adjust the essential allowlist or isolation policy                                 |

Each module's documentation (under [`modules/`](./modules/)) lists its
exported types and functions — those are the seam. Internal helpers
are not part of the contract.

## Remote-cache subsystem (detail)

`vzn run` looks at `VZN_REMOTE_CACHE_URL` + `VZN_REMOTE_CACHE_TOKEN`
at the top of `orchestrator.run()`. When present:

1. `wrapWithRemoteCache(localCache, log)` constructs `RemoteCache`
   with the configured URL + token + optional `teamId` / `slug` /
   `timeoutMs`.
2. Wraps it in `LayeredCache(localCache, remoteCache)`.
3. Logs `remote cache: <url>` so the user knows it's active.

Reads try local first, then remote (hydrating local on remote hit).
Writes go to local synchronously, then pack + PUT to remote
in the background. Remote errors are logged via `onRemoteError`,
never thrown — the task already succeeded; a flaky cache server
shouldn't fail the user's build.

The wire spec is Turborepo `/v8/artifacts/{hash}` verbatim, so the
client interops with any turbo-compatible server (`ducktors/turborepo-remote-cache`,
`Fox32/openturbo-remote-cache`, Vercel's hosted cache). The
**tar interior** is ours (`meta.json` + `outputs/`), not Turbo's —
servers don't inspect the body, so this is invisible to them. See
`docs/design/remote-cache.md` for the full protocol.

## Sandbox subsystem (detail)

When `vzn run --sandbox` is set, `executeTask` routes each task
through `sandbox.runSandboxed` instead of `runner.runCommand`. The
sandbox bind-mounts only the resolved `cache.inputs.files` (read-only)
plus the project dir (read-write); everything else returns `ENOENT`.
Linux uses `bwrap`; macOS uses `sandbox-exec`. The orchestrator
fails loud when the helper isn't installed — silent fall-through
would defeat the contract.

See `docs/design/sandbox.md` for design rationale.

## Design principles

The codebase consistently chooses the same trade-offs:

1. **Explicit over magical.** Defaults exist but are narrow and
   documented. Where ambiguity is dangerous (cache inputs, outputs,
   env isolation), declaration is required.
2. **One command per task.** `exec: { command }` runs a single shell
   command. To chain steps, use shell composition (`&&`, `;`) or
   split into separate tasks linked by `dependsOn.self`.
3. **Shell is the API.** Commands are strings, the shell is the
   sandboxing layer. No JS-function tasks.
4. **Resolved values, not literal source.** The cache key derives
   from the _evaluated_ config (so imports and computed values are
   captured), not from the file bytes.
5. **Cascade through the dependency graph.** Upstream cache changes
   automatically invalidate dependents via folded-in cache hashes;
   workspace-level changes (lockfile, workspace yaml) cascade to all
   tasks via the workspace fingerprint.
6. **Fail loud on the contract.** When the user asks for sandboxing,
   we don't silently fall through to unsandboxed; when the cache key
   shape changes, we bump `CACHE_VERSION` and orphan old entries
   rather than reading possibly-stale data.

## What's intentionally absent

See [`README.md` § Out of scope](../README.md#out-of-scope-by-design)
for the deliberate non-features. The most relevant for understanding
the architecture:

- **No plugin protocol.** Presets are TypeScript helpers that _return_
  `TaskConfig` objects, evaluated at config-load time. The runner
  doesn't know they exist.
- **No daemon.** Every `vzn run` invocation is a fresh process.
  Loaders use jiti's `moduleCache: false` so config edits show up
  next run.
- **No nested task graphs.** The unit of caching, scheduling, and
  reporting is the task. For parallelism, define separate tasks
  linked by `dependsOn`. For chained commands inside one task, use
  shell composition (`&&`, `;`) in `exec.command`.
