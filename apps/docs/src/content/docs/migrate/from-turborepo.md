---
title: Migrate from Turborepo
description: Move a Turborepo monorepo to vx. What maps 1:1, what's better, and how vx migrate converts your turbo.json into vx.config.ts files automatically.
---

vx is shaped like Turborepo on purpose, so this is the easy migration.
Same per-package model, same `dependsOn` micro-syntax, same `--filter`
DSL, same `--affected` selection. The main change
is that config moves from one `turbo.json` to per-package `vx.config.ts`
files — and `vx migrate` writes them for you.

## Let `vx migrate` do it

```bash
bun add -d @vzn/vx
vx migrate --dry        # preview the generated files + a report
vx migrate              # write them (won't overwrite without --force)
```

`vx migrate` detects your `turbo.json`, reads the root pipeline and any
per-package `extends`, inlines the matching `package.json` scripts as task
commands, and emits a `vx.config.ts` per package. It only emits a task
where the script actually exists, and any value it can't infer becomes a
`TODO(vx-migrate)` **comment** — never a silent wrong value. Review the
output, fill in the TODOs, and run.

## What maps directly

| Turborepo (`turbo.json`)        | vx (`vx.config.ts`)                              |
| ------------------------------- | ------------------------------------------------ |
| `tasks` / `pipeline`            | `tasks`                                          |
| a task's `dependsOn`            | `dependsOn` — identical `'build'`, `'^build'`, `'pkg#build'` syntax |
| `outputs`                       | `cache.outputs.files`                            |
| `inputs`                        | `cache.inputs.files`                             |
| `env`                           | `cache.inputs.env` **and** `exec.env.passThrough` |
| `passThroughEnv`                | `exec.env.passThrough`                           |
| `cache: false`                  | omit the `cache` block (the task always runs)    |
| `persistent: true`              | `exec.persistent: { … }`                         |
| `$TURBO_ROOT$/file`             | `cache.inputs.workspaceFiles` / `outputs.workspaceFiles` |
| `globalDependencies` / `globalEnv` / `globalPassThroughEnv` | a generated root `vx-preset.ts` you import and spread |

The command itself comes from your `package.json` script (Turborepo runs
the script of the same name; vx makes the command explicit in `exec`).

### Before / after

`vx migrate` reads your `turbo.json` and writes a `vx.config.ts` per
package — scripts inlined as `exec.command`, everything it can't infer
left as a `TODO` comment. Here's the same `build`/`test` pipeline before
and after:

```jsonc
// turbo.json  (before)
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json"],
      "outputs": ["dist/**"],
      "env": ["NODE_ENV"]
    },
    "test": { "dependsOn": ["build"], "outputs": [] }
  }
}
```

```ts
// packages/app/vx.config.ts  (after — generated, then reviewed)
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b', env: { passThrough: ['NODE_ENV'] } },
      dependsOn: ['^build'],
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'], env: ['NODE_ENV'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'bun test' },
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
  },
})
```

Note `env` becomes **two** entries: `inputs.env` (so a change busts the
cache) and `exec.env.passThrough` (so the command can see it). vx isolates
the child environment — [Environment variables](../../guides/environment-variables/)
explains why.

## What you'll notice is better

- **Your config is TypeScript.** Share presets with imports instead of
  copy-pasting JSON across packages — and because vx hashes the *resolved*
  config, a preset change correctly invalidates the cache.
- **No stale files after a restore.** Turborepo restores additively;
  vx wipes declared outputs before restore, so `dist/` is exactly the
  cached snapshot.
- **Sparse `^task` bridging.** `^build` reaches *through* packages that
  don't declare the task to the nearest one that does — no more no-op
  tasks scattered across the repo. Turborepo stops at direct deps.
- **Faster.** vx's warm, fully-cached runs lead Turborepo in the repo's
  head-to-head benchmark (`bun bench/compare.ts`, results in
  [Benchmarks](../../benchmarks/)).

## Commands you already know

| Turborepo                         | vx                              |
| --------------------------------- | ------------------------------- |
| `turbo run build`                 | `vx run build --all`            |
| `turbo run build --filter=@app/*` | `vx run build --filter "@app/*"`      |
| `turbo run build --affected`      | `vx run build --affected`       |
| `turbo run build --dry`           | `vx run build --dry`            |
| `turbo run build -- --flag`       | `vx run build -- --flag`        |
| `TURBO_TOKEN` / remote cache      | a remote-cache plugin connection                         |

The remote cache is plugin-driven: `@vzn/vx-reapi` connects any Bazel
REAPI server (NativeLink, BuildBuddy, Buildbarn, bazel-remote), or bring a
Turbo-wire server through a small cache plugin (see
[Core is provider-neutral](../../guides/extensibility/)). See
[Remote caching](../../guides/remote-caching/).

## A couple of differences to expect

- **Caching is opt-in and explicit.** Where Turborepo caches by default,
  vx requires a `cache` block with both `inputs` and `outputs`. This is
  deliberate: a forgotten cache miss costs a re-run; a stale hit ships a
  broken artifact. `vx migrate` fills these in from your `turbo.json`.
- **One command per task.** No `commands` array — chain with `&&` or split
  into `dependsOn`-linked tasks (which also lets each step cache).
- **Default scope is the current package**, not the whole workspace. A bare
  `vx run build` inside a package runs that package (like running its
  script directly); use `--all` for Turborepo's run-everything default, or
  `--filter` / `--affected` to select.
- **No Bun needed to run vx** — `npm install -g @vzn/vx` ships a standalone
  binary. Bun (≥ 1.3) is only required when running vx from source.

## Next steps

- **[Quickstart](../../quickstart/)** — verify a cached run works.
- **[Caching tasks](../../guides/caching/)** — confirm your inputs/outputs
  are right.
- **[vx vs Turborepo vs Nx](../../comparison/)** — the full feature
  comparison.
