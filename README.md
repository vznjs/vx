# @vzn/vx

An open, extensible monorepo task runner for pnpm / npm / yarn / Bun workspaces.
TypeScript config, content-addressed cache, replaceable internals.

**Runs on [Bun](https://bun.sh) (≥ 1.3).** TypeScript source ships as the
runtime entry — no compile step on install. SQLite is via `bun:sqlite`.

```sh
bun add -d @vzn/vx
vx run build
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
// vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      dependsOn: ['^build'], // Turbo's `^build`
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
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      cache: {
        inputs: { files: ['src/**'] },
        outputs: { files: [] }, // cache the no-op success
      },
    },

    dev: {
      // No `cache` field → always runs.
      exec: { command: 'vite', env: { passThrough: ['VITE_API_URL'] } },
    },

    // Umbrella task — group node, no exec. `vx run ci` fans out.
    ci: {
      dependsOn: ['lint', 'test'],
    },
  },
})
```

The full schema reference, including every field and its semantics, is
in [`docs/schema.md`](./docs/schema.md).

## CLI

```sh
vx run [TASK | PKG#TASK ...] [--all] [--filter <pattern>] [--concurrency <n>] [--no-cache] [--excludeDependencies] [--verbosity <n>] [-- forwarded-args...]
vx cache prune [--older-than 30d] [--max-size 1G]
```

Default scope: the project containing cwd (deps still expand via
`dependsOn`). Use `--all` for every project, `--filter` for a pnpm-style
filter DSL, or `pkg#task` to target one project directly. Pass
multiple positionals to run several tasks in one invocation
(`vx run build lint test`). Args after `--` are forwarded (shell-
quoted) to the task's `exec.command` and folded into the cache key.

Output is Turbo-style: framed per-task blocks with status indicators
(`cache hit • <hash>`, `executed`, `FAILED (exit N)`, `from local
cache` / `from remote cache`) and a summary line that prints
`>>> FULL CACHE` when every real task was cached.

Full CLI reference: [`docs/cli.md`](./docs/cli.md). Side-by-side with
Turborepo / Nx / vite-task: [`docs/comparison.md`](./docs/comparison.md).

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

## Compared to Turborepo / Nx / vite-task

- **Per-package TypeScript config** (vs Turbo's single `turbo.json`,
  Nx's JSON `project.json`, vite-task's per-package config). Type-safe
  inference, shared presets via plain imports.
- **No executors.** Nx's plugin abstraction has real cost (versioned
  packages, runtime indirection); we keep the shell as the API.
- **Turbo-shape caching, wire-compatible** — content-addressed key,
  output restore, plus a remote-cache HTTP client that speaks the
  Turbo `/v8/artifacts/` API (works against `ducktors/turborepo-remote-cache`
  et al.).
- **Resolved-config hash** captures values that flowed in through
  `import` statements at config-load time — Turbo can't see those.
- **Strict output cleaning.** Declared `cache.outputs.files` are wiped
  before exec AND before cache restore, so the project dir ends every
  run bit-identical to the cached snapshot.

Feature-by-feature side-by-side with each tool, including known gaps:
[`docs/comparison.md`](./docs/comparison.md).

## Status

Pre-alpha. Schema may shift. No published versions yet.

## Development

```sh
bun install
bun run lint        # → vx run lint (oxlint --type-aware --type-check)
bun run format      # → vx run format (oxfmt)
bun run test        # → vx run test (bun test)
bun run ci          # → vx run ci (group: format-check + lint + test)
```

vx dogfoods itself — every dev task routes through `bun src/bin.ts run
<task>` per `vx.config.ts`, which is what CI invokes too.

No build step. TypeScript source ships as-is; Bun runs it directly.
Lint, format, and types are all checked by the oxc toolchain — no tsc,
no prettier.

Architecture: [`docs/architecture.md`](./docs/architecture.md).
Tests live under [`tests/`](./tests/), one file per src module.

## License

MIT
