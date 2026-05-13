# Config schema

Complete reference for every field accepted by `vx.config.ts` (or
`.mts`, `.js`, `.mjs`). Types live in `src/config.ts` and
are re-exported from `@vzn/vx`.

## Top-level shape

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    <taskName>: TaskConfig,
    ...
  },
})
```

`defineProject` is an identity function — it exists purely so
TypeScript can infer types when you author a config.

`tasks` is a `Record<string, TaskConfig>`. Task names are arbitrary
strings; they're referenced by `dependsOn`, by `cache.inputs.tasks`,
and by the CLI (`vx run <taskName>`).

## `TaskConfig`

```ts
interface TaskConfig {
  description?: string // optional one-line blurb for the picker / --dry view
  exec?: ExecConfig // optional — omit to declare a group task
  dependsOn?: readonly string[] // optional; Turbo/Nx micro-syntax
  cache?: CacheConfig // optional — caching is opt-in; requires `exec`
}
```

### `description` (optional)

A short one-line blurb describing the task. Pure metadata — has no
effect on caching, scheduling, or execution. Surfaced in two places:

- The interactive task picker (`vx run` with no positional in a TTY)
  — printed to the right of each `pkg#task` id.
- The `--dry` text preview — printed on a second indented line under
  the cache-status row.
- `--dry=json` includes it on each task entry too.

```ts
test: {
  description: 'bun test against the tests/ tree',
  exec: { command: 'bun test' },
  cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
}
```

A task either has an `exec` (it does work), or omits `exec` and provides
a `dependsOn` (it's a **group**). Group tasks are pure aggregators —
nothing spawns, no cache lookup, no I/O. Useful for umbrella commands:

```ts
// vx run install --all  →  fans out to `build` in every workspace dep
install: {
  dependsOn: ['^build'],
}

// vx run ci  →  runs build then test in the cwd project
ci: {
  dependsOn: ['build', 'test'],
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
to, or split into separate tasks linked by `dependsOn`.

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
  persistent?: PersistentConfig // long-running task (dev server, watcher)
}
```

##### `persistent` (optional)

Marks the task as a long-running process — a dev server, a file
watcher, a daemon. The runner spawns the command but does NOT wait
for it to exit. Instead it considers the task "ready":

- Immediately on successful spawn when no `readyWhen` is given.
- On the first stdout/stderr line that matches the `readyWhen`
  regex string.

```ts
interface PersistentConfig {
  readyWhen?: string // regex; first matching line marks ready
}
```

```ts
dev: {
  exec: {
    command: 'vite',
    persistent: { readyWhen: 'Local:' },
  },
}

watch: {
  exec: {
    command: 'tsc --watch --preserveWatchOutput',
    persistent: { readyWhen: 'Watching for file changes' },
  },
}
```

Semantics:

- Downstream tasks (`dependsOn` from another task) unblock on ready,
  not on exit. Useful for e2e tests that need a dev server up first.
- If the persistent task exits BEFORE `readyWhen` matches, the task
  is reported as `failed`.
- Once the rest of the graph finishes (success OR failure of
  downstream), the orchestrator sends `SIGTERM` to every persistent
  subprocess and waits for them to exit before returning.
- **`cache` is not allowed alongside `persistent`** — the config
  loader rejects the combination. Persistent tasks don't terminate,
  so there's no exit code to record + no outputs to capture.

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

Tasks that must complete successfully before this task runs. Turbo /
Nx-style micro-syntax — a flat array of strings:

```ts
dependsOn: readonly string[]
```

Each entry is one of:

| Form         | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `'name'`     | Same-project task `name`.                                         |
| `'^name'`    | The `name` task in every transitive workspace dependency.         |
| `'pkg#name'` | The `name` task in a specific other package (cross-project edge). |

Examples:

```ts
dependsOn: ['build'] // bare = Turbo's `build`
dependsOn: ['^build'] // = Turbo's `^build`
dependsOn: ['codegen', '^build'] // both
dependsOn: ['lib#build', 'shared#test'] // cross-project edges
```

Semantics:

- **Same-project** — task name must exist in this project's `tasks`
  map; missing target is a hard error at graph-build time.
- **`^name`** — task is added for every transitive workspace dep that
  has it. Deps that don't declare it are silently skipped (it's normal
  for tasks to be sparse).
- **`pkg#name`** — missing pkg/task is a hard error (you named them
  explicitly).
- **No wildcards or negation here.** Those operations belong in
  `cache.inputs.tasks` (filtering hash inputs), not `dependsOn`
  (declaring graph edges).
- **Cycle detection** — runs across the whole resolved graph at the
  end of graph building. Cycles throw with a path-formatted message.

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
  tasks?: readonly string[] // optional; same micro-syntax as dependsOn
}
```

##### `inputs.files` (required)

Project-relative globs. `!`-prefix negates.

- `['**/*']` — all project files (gitignore-aware).
- `['src/**', '!**/*.test.ts']` — narrow with exclusion.
- `[]` — no file inputs (cache key still includes command + env + upstream).

Always applied to every glob pass:

- gitignore filter (workspace-root `.gitignore` + project `.gitignore`)
- always-ignored: `node_modules/**`, `.git/**`, `.vx/**`, `*.tsbuildinfo`
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

Same micro-syntax as `dependsOn`, with two extras for filtering:

| Form         | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `'*'`        | Include every same-project upstream hash.      |
| `'^*'`       | Include every dep-workspace upstream hash.     |
| `'name'`     | Include same-project task `name`.              |
| `'^name'`    | Include `name` in every dep workspace.         |
| `'pkg#name'` | Include the specific package's `name` task.    |
| `'!<form>'`  | Exclude — any of the above with a leading `!`. |

Patterns are applied in order; **last write wins**. So
`['*', '^*', '!^noisy']` reads as "all upstream except deps' noisy".

Defaults:

- Omitted → all upstream contribute (same as `['*', '^*']`). Most
  common case.
- `[]` → fully decoupled; no upstream contributes.

Examples:

```ts
tasks: ['^build'] // only ^build from deps; nothing from self
tasks: ['codegen', '^*'] // self.codegen + all deps
tasks: ['*', '^*', '!^noisy'] // all upstream except deps.noisy
tasks: ['lib#build'] // a single cross-project hash
tasks: [] // fully decoupled
```

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

Loaded from `vx.workspace.{ts,mts,js,mjs}` at the workspace root —
the same directory that contains `pnpm-workspace.yaml`. The file is
**optional**: when missing, every field falls back to its built-in
default.

```ts
interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.vx/cache`. */
  cacheDir?: string
}
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  concurrency: 8,
  cacheDir: 'build/.vx-cache',
})
```

- `concurrency`: a CLI `-c <n>` flag still wins.
- `cacheDir`: relative paths are resolved against the workspace root.
  Absolute paths are honoured as-is. `vx run` and `vx stats` both
  read from the resolved location.

Reserved for future workspace-level features like `globalInputs` (a
workspace-wide file set folded into every task's key — useful for
shared root configs like `tsconfig.base.json`).

## Helpers

```ts
import { defineProject, defineWorkspace } from '@vzn/vx'

// Identity functions; their purpose is type inference.
defineProject<T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

Use them so TypeScript can narrow literal types in your config (autocomplete

- stricter validation against the schema).

## Full example

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'],
      cache: {
        inputs: {
          files: ['src/**', '!**/*.test.ts', 'tsconfig.json', 'package.json'],
          env: ['NODE_ENV'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    test: {
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      cache: {
        inputs: { files: ['src/**'] },
        outputs: { files: [] },
      },
    },

    package: {
      exec: { command: 'rm -rf pkg && npm pack --pack-destination ./pkg' },
      dependsOn: ['build', 'test'],
      cache: {
        inputs: {
          files: ['package.json'],
          tasks: ['build', '^build'],
        },
        outputs: { files: ['pkg/*.tgz'] },
      },
    },

    dev: {
      // No cache field → always runs.
      exec: { command: 'vite', env: { passThrough: ['CI', 'VITE_API_URL'] } },
    },

    // Umbrella / group task — no exec, just chains deps. `vx run ci`
    // fans out, and the group itself is silent in the run output.
    ci: {
      dependsOn: ['build', 'test'],
    },
  },
})
```
