# @vzn/run

An open, extensible monorepo task runner for pnpm workspaces.
TypeScript config, content-addressed cache, replaceable internals.

**Runs on [Bun](https://bun.sh) (≥ 1.3).** TypeScript source ships as the
runtime entry — no compile step on install. SQLite is via `bun:sqlite`.

```sh
bun add -d @vzn/run
vzn run build
```

> **Complete technical documentation lives in [`docs/`](./docs/).**
> Start with [`docs/README.md`](./docs/README.md) for the index. Then
> [`docs/architecture.md`](./docs/architecture.md) for the design,
> [`docs/schema.md`](./docs/schema.md) for every config field,
> [`docs/caching.md`](./docs/caching.md) for how the cache works, and
> one focused module reference per source file under
> [`docs/modules/`](./docs/modules/).

## Config at a glance

```ts
// vzn.config.ts
import { defineProject } from '@vzn/run'

export default defineProject({
  run: {
    tasks: {
      build: {
        exec: { command: 'tsc -b' },
        dependsOn: { dependencies: ['build'] }, // Turbo's `^build`
        cache: {
          inputs: {
            files: ['src/**', '!**/*.test.ts'],
            env: ['NODE_ENV'], // host values that bust cache
            tasks: { dependencies: ['build'] }, // upstream hashes to fold in
          },
          outputs: { files: ['dist/**'] },
        },
      },

      test: {
        exec: { command: 'vitest run', env: { passThrough: ['CI'] } },
        dependsOn: { self: ['build'] },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: [] }, // cache the no-op success
        },
      },

      dev: {
        // No `cache` field → always runs.
        exec: { command: 'vite', env: { passThrough: ['VITE_API_URL'] } },
      },
    },
  },
})
```

The full schema reference, including every field and its semantics, is
in [`docs/schema.md`](./docs/schema.md).

## CLI

```sh
vzn run [TASK | PKG#TASK] [-r] [-F <pattern>] [-c <n>] [--no-cache] [--ignore-depends-on] [-v] [-- forwarded-args...]
```

Default scope: the project containing cwd (deps still expand via
`dependsOn`). Use `-r` for every project, `-F` for a pnpm-style filter
DSL, or `pkg#task` to target one project directly. Args after `--` are
forwarded (shell-quoted) to the task's `exec.command` and folded into
the cache key.

Full CLI reference: [`docs/cli.md`](./docs/cli.md).

## Key properties

- **Explicit, no magic.** Caching is opt-in. `cache.inputs.files` is
  required when caching is enabled. No hidden globs, no `$TURBO_DEFAULT$`
  tokens.
- **Isolated env.** Tasks see only an essential allowlist + declared
  `passThrough` (host values) + `define` (literal values). Everything
  else is invisible to the child.
- **Resolved-config hashing.** Imports and computed values in your
  TypeScript config are captured automatically — the cache key sees
  the post-evaluation object.
- **Cascading invalidation.** Upstream task changes propagate through
  `cache.inputs.tasks`; workspace-level changes (lockfile,
  pnpm-workspace.yaml) invalidate everything.
- **Project boundaries.** Nested projects' files never leak into a
  parent's inputs. The only cross-project relationship is `dependsOn`.
- **Shell is the API.** Commands are strings. No executor plugin
  protocol, no JS-function tasks. Presets are TypeScript helpers that
  return `TaskConfig` objects — evaluated at config-load time.

See [`docs/architecture.md`](./docs/architecture.md) for the design
rationale and module layout.

## Compared to Turborepo / NX / vite-task

- **Per-package TypeScript config** (vs Turbo's single `turbo.json`,
  NX's JSON `project.json`, vite-task's per-package JSON). Type-safe
  inference, shared presets via plain imports.
- **No executors.** NX's plugin abstraction has real cost (versioned
  packages, runtime indirection); we keep the shell as the API.
- **Same Turbo-shape caching** — content-addressed key including
  command, env, file contents, upstream hashes, workspace fingerprint.
- **Resolved-config hash** captures values that flowed in through
  `import` statements at config-load time — Turbo can't see those.

A more detailed comparison is woven through
[`docs/architecture.md`](./docs/architecture.md) and
[`docs/caching.md`](./docs/caching.md).

## Status

Pre-alpha. Schema may shift. No published versions yet.

## Development

```sh
bun install
bun run lint        # oxlint with type-aware checks (via tsgolint)
bun run format      # oxfmt
bun test src/       # 155 tests under bun:test
```

No build step. TypeScript source ships as-is; Bun runs it directly.
Lint, format, and types are all checked by the oxc toolchain — no tsc,
no prettier.

Architecture: [`docs/architecture.md`](./docs/architecture.md).
Tests live next to each source module as `*.test.ts`.

## License

MIT
