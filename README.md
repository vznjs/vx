# @vzn/run

An open, extensible monorepo task runner. Turborepo-shaped caching semantics
with per-package TypeScript config and replaceable internals.

```sh
pnpm add -D @vzn/run
vzn run build
```

## Config

```ts
// vzn.config.ts in a workspace package
import { defineProject } from '@vzn/run'

export default defineProject({
  tasks: {
    build: {
      process: {
        command: 'tsc -b',
        passThroughEnv: ['AWS_REGION'],
        env: { NODE_ENV: 'production' },
      },
      dependsOn: { dependencies: ['build'] },
      cache: {
        inputs: {
          files: ['src/**', '!**/*.test.ts'],   // required; pass ['**/*'] for all
          env: ['NODE_ENV'],
          tasks: ['*', '!lint'],
        },
        outputs: {
          files: ['dist/**'],
        },
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

Tasks that must complete before this one runs. Two buckets, both
optional, both arrays of task names:

```ts
dependsOn: {
  self?: string[]          // tasks in this same project
  dependencies?: string[]  // tasks to run in every transitive workspace dep
}
```

- `{ dependencies: ['build'] }` — Turbo's `^build`. Most common case.
- `{ self: ['codegen'] }` — Turbo's bare `codegen`. Same-project ordering.
- `{ self: ['codegen'], dependencies: ['build'] }` — both.
- omit the field — no dependencies.

Same-project tasks must exist (missing target throws). Workspace-dep
tasks that aren't declared on a given dep are silently skipped.

### `cache`

**Caching is opt-in.** Omit the whole `cache` field and the task always
runs (no read, no write). Provide a `cache` block — with `outputs` at
minimum — to enable caching.

```ts
cache: {
  inputs: {                        // required; declare what participates in the key
    files: ['**/*'],               // required; '**/*' for all project files
    env?: ['NODE_ENV'],
    tasks?: ['*'],
  },
  outputs: {                       // required; declare what this task produces
    files: ['dist/**'],            // required; pass [] if there are none
  },
}
```

- `outputs.files` (required): project-relative globs the task produces.
  Captured for restore on hit. Pass `[]` for tasks with no produced
  files (e.g. `lint`, `typecheck`) when you still want to cache the
  no-op success.

- `inputs` (required): what participates in the cache key. Forcing
  declaration here makes you decide what the cache is keyed on; no
  silent "all files" default that you forget to revisit.

  | Field | Required | Meaning |
  | --- | --- | --- |
  | `files` | yes | project-relative globs (`!` to negate). Use `['**/*']` for all project files. |
  | `env` | no | env var names; their current values participate in the key. |
  | `tasks` | no | which upstream tasks' cache keys fold in. Patterns: `'*'` = all dependsOn, `'name'` = include literal, `'!name'` = exclude literal. Default `['*']`. |

  File globs are always gitignore-aware (whether you write `['**/*']`
  or a narrow list). Declared outputs and any nested vzn project's
  directory are excluded automatically — a task cannot invalidate
  itself, and cannot read across project boundaries.

  Outputs are *not* filtered through gitignore — so `dist/` and friends
  get captured normally.

  Note: package version changes are picked up automatically because
  `package.json` is part of the file set if matched by your `files` glob.

## Caching strategy

A task's cache key is derived from:

1. A hash of the resolved task config (post-evaluation): command, env
   names, dependsOn, cache directives, outputs, passThroughEnv list,
   process.env explicit values, etc.
2. Declared env-input values (from parent process.env at hash time).
3. Input file contents — `cache.inputs.files` resolved with gitignore
   filtering, declared outputs excluded, nested-project files excluded.
4. Upstream tasks' cache keys, filtered by `cache.inputs.tasks`.
5. Workspace fingerprint — a hash of `pnpm-lock.yaml` and
   `pnpm-workspace.yaml`. A `pnpm update` (resolved version bump) or a
   workspace-shape change invalidates every task's cache.

Cache hit → outputs restored, captured stdout / stderr replayed. Miss →
the task runs, outputs are captured, the entry is saved.

This is Turbo-style: an upstream's cache-key change cascades. A change
to a file in an upstream package will invalidate every dependent whose
`cache.inputs.tasks` includes that upstream — even if the produced
output bytes are unchanged.

## CLI

```sh
vzn run <task> [--project <name>]... [--concurrency <n>] [--force]
```

- `--project, -p`: run only for the named project (repeatable).
- `--concurrency, -c`: max parallel tasks. Defaults to CPU count.
- `--force, -f`: ignore cache hits and re-run. Writes still update cache.

## Architecture

Each layer is one module under `src/`, replaceable wholesale:

```
config.ts           public schema + defineProject / defineWorkspace helpers
workspace.ts        pnpm discovery
project-loader.ts   jiti for .ts / native import for .mjs (mtime-busting)
package-graph.ts    workspace dep graph
task-graph.ts       task graph build + cycle detection
inputs.ts           file globs, env values, gitignore-aware resolution
env.ts              essentials + passThroughEnv + explicit env layers
cache.ts            content-addressed FS cache
runner.ts           child_process.spawn
scheduler.ts        parallel topo executor with failure isolation
orchestrator.ts     glue
cli.ts              argv parser + command dispatcher
bin.ts              `vzn` binary entry
```

No plugin API, no DI: replace a layer by changing imports.

## Status

Pre-alpha. Schema may change. No published versions yet.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
