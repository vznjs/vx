# Config schema

Complete reference for every field accepted by `vzn.config.ts` (or
`.mts`, `.js`, `.mjs`). Types live in `src/config.ts` and
are re-exported from `@vzn/run`.

## Top-level shape

```ts
import { defineProject } from '@vzn/run'

export default defineProject({
  run: {
    tasks: {
      <taskName>: TaskConfig,
      ...
    },
  },
})
```

`defineProject` is an identity function — it exists purely so
TypeScript can infer types when you author a config.

The top-level `run` namespace exists so future `@vzn/*` sibling packages
(e.g. `@vzn/lint`, `@vzn/test`) can add their own top-level keys without
colliding with the task runner's surface.

`run.tasks` is a `Record<string, TaskConfig>`. Task names are arbitrary
strings; they're referenced by `dependsOn`, by `cache.inputs.tasks`,
and by the CLI (`vzn run <taskName>`).

## `TaskConfig`

```ts
interface TaskConfig {
  exec?: ExecConfig // optional — omit to declare a group task
  dependsOn?: TaskDependsOn // optional
  cache?: CacheConfig // optional — caching is opt-in; requires `exec`
}
```

A task either has an `exec` (it does work), or omits `exec` and provides
a `dependsOn` (it's a **group**). Group tasks are pure aggregators —
nothing spawns, no cache lookup, no I/O. Useful for umbrella commands:

```ts
// vzn run install -r  →  fans out to `build` in every workspace dep
install: {
  dependsOn: { dependencies: ['build'] },
}

// vzn run ci  →  runs build then test in the cwd project
ci: {
  dependsOn: { self: ['build', 'test'] },
}
```

A group task that's required as an upstream of a caching task does
contribute a stable hash (rolled up from its own dependencies), so
cache invalidation cascades correctly when anything beneath the group
changes. Group tasks are **not** recorded in the `runs` analytics
table — they aren't real runs.

### `exec` (optional — required for non-group tasks)

A single shell command with optional env. Multi-step is intentionally
not supported — chain commands in the shell (`&&` / `;`) when you need
to, or split into separate tasks linked by `dependsOn.self`.

```ts
exec: {
  command: 'tsc -b'
}

exec: {
  command: 'gen && tsc && cp -r assets dist/'
}
```

#### `ExecConfig`

```ts
interface ExecConfig {
  command: string // shell command, run from the project's dir
  env?: ExecEnv // optional per-step env
}
```

##### `ExecEnv`

```ts
interface ExecEnv {
  passThrough?: string[] // names taken from host process.env
  define?: Record<string, string> // explicit name=value pairs
}
```

- **`passThrough`** — env var names whose host values are forwarded to
  the child. _NOT_ folded into the cache key — for secrets, regional
  vars, CI flags that shouldn't bust caches.
- **`define`** — explicit literal values set on the child. _ARE_ folded
  into the cache key via the task config hash (the values are in your
  config file).

Child process env, lowest to highest priority:

1. Hard-coded essential allowlist (`PATH`, `HOME`, `SHELL`, `TMPDIR`,
   `LANG`, `TERM`, etc. — full list in `src/env.ts`).
2. `passThrough` names, value taken from host `process.env`.
3. `define` literal values.

Anything outside these three layers is invisible to the child process.

### `dependsOn` (optional)

Tasks that must complete successfully before this task runs.

```ts
interface TaskDependsOn {
  self?: string[] // tasks in this project
  dependencies?: string[] // tasks in every transitive workspace dep
}
```

- `{ self: ['build'] }` — Turbo's bare `build` notation. Same-project
  task ordering.
- `{ dependencies: ['build'] }` — Turbo's `^build` notation. Run
  `build` in every transitive workspace dependency before this task.
- `{ self: ['codegen'], dependencies: ['build'] }` — both.
- omitted — no dependencies.

Semantics:

- **Same-project (`self`)** — task name must exist in this project's
  `tasks` map, otherwise a hard error is thrown at graph-build time.
- **Workspace-dep (`dependencies`)** — the task is added for every
  transitive workspace dep that _has_ it. Deps that don't declare it
  are silently skipped (it's normal for tasks to be sparse).
- **Cycle detection** — runs across the whole resolved graph at the end
  of graph building. Cycles throw with a path-formatted message.

### `cache` (optional)

```ts
interface CacheConfig {
  inputs: CacheInputs // required when cache is provided
  outputs: CacheOutputs // required when cache is provided
}
```

**Caching is opt-in.** Omit `cache` and the task always runs (no read,
no write). To enable caching you must provide both `inputs` and
`outputs`. Forces a deliberate decision about what the cache is keyed
on and what gets captured.

#### `CacheInputs`

```ts
interface CacheInputs {
  files: string[] // required
  env?: string[] // optional
  tasks?: TaskDependsOn // optional; same shape as dependsOn
}
```

##### `inputs.files` (required)

Project-relative globs. `!`-prefix negates.

- `['**/*']` — all project files (gitignore-aware).
- `['src/**', '!**/*.test.ts']` — narrow with exclusion.
- `[]` — no file inputs (cache key still includes command + env + upstream).

Always applied to every glob pass:

- gitignore filter (workspace-root `.gitignore` + project `.gitignore`)
- always-ignored: `node_modules/**`, `.git/**`, `.vzn/**`, `*.tsbuildinfo`
- declared `outputs.files` (so a task never invalidates itself)
- nested-project subtree (no cross-project file references)

##### `inputs.env` (optional, default `[]`)

Env var names whose host values are folded into the cache key.
**Independent of `exec.env`**:

- Forwarding a name in `exec.env.passThrough` does NOT make its value
  affect the cache.
- Listing a name here does NOT forward it to the child.

To forward AND track, list it in both places. The common case has
double-declaration as a result — `passThrough: ['NODE_ENV']` and
`cache.inputs.env: ['NODE_ENV']`. This will likely be sugared by
preset helpers (`envTracked('NODE_ENV')`).

##### `inputs.tasks` (optional, default = all upstream)

Same shape as `dependsOn`. Filters which upstream tasks' cache keys
contribute to this task's key.

**Per-bucket defaults:**

- Omitting a bucket (`self` or `dependencies`) → all upstream from that
  source contribute.
- Providing an explicit array → only matched names contribute.

**Pattern syntax inside a bucket, applied in order (last write wins):**

- `'*'` — include all from this bucket
- `'name'` — include literal task name
- `'!name'` — exclude literal task name

Examples:

- omitted entirely → all upstream contribute (most common).
- `{ dependencies: ['build'] }` → only `build` from deps; same-project
  upstream stays default-all.
- `{ dependencies: ['*', '!noisy'] }` → all deps except `noisy`.
- `{ self: [], dependencies: [] }` → fully decoupled.

#### `CacheOutputs`

```ts
interface CacheOutputs {
  files: string[] // required
}
```

Project-relative globs of files the task produces. Captured on cache
write, restored on cache hit (overwriting any local modifications).

- `['dist/**']` — typical build output.
- `[]` — empty is valid for tasks with no produced files (e.g.
  `lint`, `typecheck`); you still cache the no-op success.

Outputs are **NOT** filtered through gitignore — so `dist/` and friends
get captured even when gitignored (which they usually are).

## `WorkspaceConfig`

Loaded from `vzn.workspace.{ts,mts,js,mjs}` at the workspace root —
the same directory that contains `pnpm-workspace.yaml`. The file is
**optional**: when missing, every field falls back to its built-in
default.

```ts
interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.vzn/cache`. */
  cacheDir?: string
}
```

```ts
// vzn.workspace.ts
import { defineWorkspace } from '@vzn/run'

export default defineWorkspace({
  concurrency: 8,
  cacheDir: 'build/.vzn-cache',
})
```

- `concurrency`: a CLI `-c <n>` flag still wins.
- `cacheDir`: relative paths are resolved against the workspace root.
  Absolute paths are honoured as-is. `vzn run` and `vzn stats` both
  read from the resolved location.

Reserved for future workspace-level features like `globalInputs` (a
workspace-wide file set folded into every task's key — useful for
shared root configs like `tsconfig.base.json`).

## Helpers

```ts
import { defineProject, defineWorkspace } from '@vzn/run'

// Identity functions; their purpose is type inference.
defineProject<T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

Use them so TypeScript can narrow literal types in your config (autocomplete

- stricter validation against the schema).

## Full example

```ts
import { defineProject } from '@vzn/run'

export default defineProject({
  run: {
    tasks: {
      build: {
        exec: { command: 'tsc -b' },
        dependsOn: { dependencies: ['build'] },
        cache: {
          inputs: {
            files: ['src/**', '!**/*.test.ts', 'tsconfig.json', 'package.json'],
            env: ['NODE_ENV'],
          },
          outputs: { files: ['dist/**'] },
        },
      },

      test: {
        exec: { command: 'vitest run', env: { passThrough: ['CI'] } },
        dependsOn: { self: ['build'] },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: [] },
        },
      },

      package: {
        exec: { command: 'rm -rf pkg && npm pack --pack-destination ./pkg' },
        dependsOn: { self: ['build', 'test'] },
        cache: {
          inputs: {
            files: ['package.json'],
            tasks: { self: ['build'], dependencies: ['build'] },
          },
          outputs: { files: ['pkg/*.tgz'] },
        },
      },

      dev: {
        // No cache field → always runs.
        exec: { command: 'vite', env: { passThrough: ['CI', 'VITE_API_URL'] } },
      },
    },
  },
})
```
