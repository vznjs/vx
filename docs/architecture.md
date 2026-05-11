# Architecture

## Module map

Each file under `src/` is one focused module. Internal
imports are unidirectional: lower modules in this table don't depend on
higher ones.

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
              ┌─────────────┼──────────────────────┐
              │             │                      │
       ┌──────▼─────┐ ┌─────▼──────┐  ┌────────────▼───────────┐
       │ scheduler  │ │ task-graph │  │      task lifecycle      │
       └────────────┘ └─────┬──────┘  │ ┌──────────────────────┐ │
                            │         │ │ inputs.ts            │ │
                     ┌──────▼───────┐ │ │ env.ts               │ │
                     │ package-graph│ │ │ cache.ts             │ │
                     └──────┬───────┘ │ │ runner.ts            │ │
                            │         │ └──────────────────────┘ │
                     ┌──────▼───────┐ └──────────────────────────┘
                     │  workspace   │  pnpm discovery
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │project-loader│  jiti for .ts, native import for .mjs
                     └──────────────┘

       config.ts:  the public schema; imported by nearly everything.
       paths.ts:   tiny POSIX-path helper for stable cache keys.
       index.ts:   re-exports the public surface.
```

## Data flow on `vzn run <task>`

1. **`cli.ts`** parses argv → `{ task, projects?, concurrency?, force? }`.
2. **`orchestrator.ts:run()`** is invoked with those options.
3. **`workspace.ts`** walks up to the nearest `pnpm-workspace.yaml`,
   parses it, and lists every package that has a `vzn.config.*` file.
   Detects duplicate package names and throws.
4. **`project-loader.ts`** evaluates each `vzn.config.ts` (or .mjs) via
   `jiti` (for TS) or native `import()` with mtime cache-busting (for
   .mjs/.js). Returns plain `ProjectConfig` objects.
5. **`package-graph.ts`** builds the workspace dependency graph from
   each project's `package.json`. Only workspace-internal deps count.
6. **`task-graph.ts`** builds the task graph: starting from the user's
   requested `(project, task)` pairs, it walks each task's `dependsOn`
   into a DAG. Cycles are detected upfront.
7. The orchestrator computes a **workspace fingerprint** (hash of
   `pnpm-lock.yaml` + `pnpm-workspace.yaml`) — used in every task's
   cache key.
8. **`scheduler.ts`** receives the task graph and an `execute(node, upstream)`
   callback. It walks the graph topologically, running up to
   `concurrency` tasks at a time. When a task fails, its dependents are
   marked `skipped` but unrelated tasks continue.
9. For each task, the orchestrator's `executeTask`:
   - Resolves inputs (**`inputs.ts`**): files (gitignore-aware, with
     declared outputs and nested-project files excluded), env values
     (`cache.inputs.env`).
   - Computes a `taskConfigHash` (sha256 of `JSON.stringify(config)`),
     for capturing imported / computed config values.
   - Asks the **`cache.ts`** layer for a cache key from those inputs +
     the workspace fingerprint + filtered upstream cache hashes.
   - On hit: restores output files, replays captured stdout/stderr,
     returns `cache-hit`.
   - On miss: walks the `exec` array, calling **`runner.ts`** for each
     step with an **`env.ts`**-built isolated env. Stops on first
     non-zero exit. On success, captures output files and writes the
     cache entry.

## Replaceability contract

Every module is structured so that swapping it requires changes only to
that module's `.ts` file and its consumers' imports. Specifically:

| Module              | What you'd replace to…                                       |
| ------------------- | ------------------------------------------------------------ |
| `workspace.ts`      | Support yarn/npm workspaces, lerna, or custom layouts        |
| `project-loader.ts` | Use a different config evaluator (esbuild, swc, native node) |
| `cache.ts`          | Add a remote cache, S3 backend, signed entries               |
| `runner.ts`         | Run inside containers, sandboxes, remote machines            |
| `scheduler.ts`      | Implement work-stealing, priority queues                     |
| `inputs.ts`         | Add fspy-style runtime input tracking                        |
| `env.ts`            | Adjust the essential allowlist or isolation policy           |

Each module's documentation (under [`modules/`](./modules/)) lists its
exported types and functions — those are the seam. Internal helpers
are not part of the contract.

## Design principles

The codebase consistently chooses the same trade-offs:

1. **Explicit over magical.** Defaults exist but are narrow and
   documented. Where ambiguity is dangerous (cache inputs, outputs,
   env isolation), declaration is required.
2. **Common case is one declaration; complex cases are expressible.**
   `exec: [{ command }]` covers 95% of tasks; multi-step is the same
   shape with more entries.
3. **Shell is the API.** Commands are strings, the shell is the
   sandboxing layer. No JS-function tasks.
4. **Resolved values, not literal source.** The cache key derives from
   the _evaluated_ config (so imports and computed values are
   captured), not from the file bytes.
5. **Cascade through the dependency graph.** Upstream cache changes
   automatically invalidate dependents via folded-in cache hashes;
   workspace-level changes (lockfile, workspace yaml) cascade to all
   tasks via the workspace fingerprint.

## What's intentionally absent

See [`README.md` § Out of scope](./README.md#out-of-scope-by-design)
for the deliberate non-features. The most relevant for understanding
the architecture:

- **No plugin protocol.** Presets are TypeScript helpers that _return_
  `TaskConfig` objects, evaluated at config-load time. The runner
  doesn't know they exist.
- **No daemon.** Every `vzn run` invocation is a fresh Node process.
  Loaders use mtime-busting URLs so config edits show up next run.
- **No nested task graphs.** The unit of caching, scheduling, and
  reporting is the task. Multi-step exec is sequential within a single
  task; for parallelism, define separate tasks with `dependsOn`.
