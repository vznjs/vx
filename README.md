# nxt

An open, extensible, smarter monorepo task runner.

## Design

- **Explicit, not magical.** No inheritance, no string DSLs, no surprise globals.
- **Solve the common case.** No knobs that exist for hypothetical needs.
- **Layered.** Each step — workspace discovery, config loading, graph, inputs,
  env, cache, runner, scheduler — is one module that can be replaced without
  touching the others. There is no global plugin registry; you just swap a
  module.

## Model

### Config

```ts
// nxt.config.ts in a workspace package
import { defineProject } from '@nxt/config'

export default defineProject({
  tasks: {
    build: {
      command: 'tsc -b',
      dependsOn: [{ task: 'build', dependencies: true }],
      env: ['NODE_ENV'],
      outputs: ['dist/**'],
    },
    test: {
      command: 'vitest run',
      dependsOn: [{ task: 'build' }],
    },
  },
})
```

Fields, in full:

- `command`: shell command, run from the project's directory.
- `dependsOn`: tasks that must complete before this one. The shape is
  `{ task, dependencies? }`:
  - `dependencies` omitted / `false` → same project.
  - `dependencies: true` → all transitive workspace dependencies.
  - `dependencies: { transitive: true | false }` → explicit form.
- `env`: env vars exposed to the task. The child sees **only** these (plus a
  small essential allowlist for shell tooling — `PATH`, `HOME`, `TMPDIR`, …).
  Their values are folded into the cache key.
- `outputs`: project-relative globs the task produces. Captured for restore on
  cache hit, and content-hashed so dependents invalidate when they change.
- `cache`: boolean, default `true`. `false` disables read/write of the cache
  for this task; its outputs are still hashed so dependents update.

### Caching

A task's cache key is derived from:

1. The shell command string.
2. Declared env names and their current values.
3. Every file in the project directory (gitignore-aware, declared outputs
   excluded — so a task does not invalidate itself).
4. The **output content hash** of each upstream task it depends on.

Cache hit → outputs are restored, captured stdout / stderr are replayed. Cache
miss → the task runs, outputs are captured, and the entry is saved.

Because (4) tracks actual produced bytes (not just upstream cache keys), a
change in an upstream's output — for any reason — propagates correctly to
dependents.

## Packages

| Package        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `@nxt/config`  | Project & workspace config types.                  |
| `@nxt/core`    | Engine: graph, scheduler, cache, task execution.   |
| `@nxt/cli`     | The `nxt` command-line interface.                  |

## CLI

```sh
nxt run <task> [--project <name>]... [--concurrency <n>] [--force]
```

- `--project, -p <name>`: run only for the named project (repeatable).
- `--concurrency, -c <n>`: max concurrent tasks. Defaults to CPU count.
- `--force, -f`: ignore cache hits and re-run. Writes still update the cache.

## Status

Pre-alpha. Schema may change. No published packages yet.

## Development

```sh
pnpm install
pnpm build       # tsc -b across workspace
pnpm typecheck
pnpm test
```

## License

MIT
