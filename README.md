# nxt

An open, extensible monorepo task runner. Turborepo-shaped caching semantics
with per-package TypeScript config and replaceable internals.

## Config

```ts
// nxt.config.ts in a workspace package
import { defineProject } from '@nxt/config'

export default defineProject({
  tasks: {
    build: {
      process: {
        command: 'tsc -b',
        passThroughEnv: ['AWS_REGION'],
        env: { NODE_ENV: 'production' },
      },
      dependsOn: [{ task: 'build', dependencies: true }],
      cache: {
        inputs: [
          { default: true },
          '!**/*.test.ts',
          { env: 'NODE_ENV' },
          { externalDependencies: ['typescript'] },
        ],
        outputs: ['dist/**'],
        dependencies: true,
      },
    },
  },
})
```

### `process`

How the task is executed. The child sees only what you list here, plus a
small essential allowlist for shell tooling (`PATH`, `HOME`, `TMPDIR`, …).

- `command`: shell command, run from the project's directory.
- `passThroughEnv`: env names whose values are passed through from the
  parent. Not folded into the cache key — for secrets, region, etc.
- `env`: explicit name=value pairs to set. Folded into the cache key.

### `dependsOn`

Tasks that must complete before this one runs. Shape:
`{ task, dependencies? }`:

- `dependencies` omitted / `false` → same project.
- `dependencies: true` → all transitive workspace deps.
- `dependencies: { transitive: true | false }` → explicit form.

### `cache`

- `enabled`: default `true`. `false` disables read/write but still
  computes the cache key so dependents are unaffected.
- `inputs`: what participates in the cache key. Omitted = all project
  files, gitignore-aware, with declared outputs excluded.

  Entries:

  | Form | Meaning |
  | --- | --- |
  | `'src/**'` | project-relative glob (prefix `!` to negate) |
  | `{ default: true }` | the implicit "all project files" set |
  | `{ env: 'NODE_ENV' }` | parent env var value |
  | `{ externalDependencies: ['typescript'] }` | declared version ranges |

  Files outside the project (root configs, etc.) are intentionally not
  reachable from per-task inputs. That belongs at the workspace level —
  see the future `defineWorkspace({ globalInputs })`.

- `outputs`: project-relative globs the task produces. Captured for
  restore on hit.
- `dependencies`: which upstream tasks' cache keys fold into this one's.
  `true` (default) = all of `dependsOn`. `string[]` = only those task
  names. `[]` = none (decouples the dependent from upstream cache).

## Caching strategy

A task's cache key is derived from:

1. The shell command string.
2. `process.env` explicit values.
3. Resolved inputs:
   - All declared file contents (hashed).
   - Declared env input values.
   - Declared external-dependency version ranges from `package.json`.
4. Upstream tasks' cache keys, filtered by `cache.dependencies`.

Cache hit → outputs restored, captured stdout / stderr replayed. Miss →
the task runs, outputs are captured, the entry is saved.

This is Turbo-style: an upstream's cache-key change cascades. A change
to a file in an upstream package will invalidate every dependent whose
`cache.dependencies` includes that upstream — even if the produced
output bytes are unchanged.

## CLI

```sh
nxt run <task> [--project <name>]... [--concurrency <n>] [--force]
```

- `--project, -p`: run only for the named project (repeatable).
- `--concurrency, -c`: max parallel tasks. Defaults to CPU count.
- `--force, -f`: ignore cache hits and re-run. Writes still update cache.

## Architecture

Each layer is one module, replaceable wholesale:

```
workspace.ts        pnpm discovery
project-loader.ts   jiti for .ts / native import for .mjs (mtime-busting)
package-graph.ts    workspace dep graph
task-graph.ts       task graph build + cycle detection
inputs.ts           globs, env, workspace, external-deps resolution
env.ts              essentials + passThroughEnv + explicit env
cache.ts            content-addressed FS cache
runner.ts           child_process.spawn
scheduler.ts        parallel topo executor with failure isolation
orchestrator.ts     glue
```

No plugin API, no DI: replace a layer by changing imports.

## Packages

| Package        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `@nxt/config`  | Project & workspace config types.                  |
| `@nxt/core`    | Engine.                                            |
| `@nxt/cli`     | The `nxt` command-line interface.                  |

## Status

Pre-alpha. Schema may change. No published packages yet.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
