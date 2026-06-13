---
title: Getting started
description: Install vx, author your first vx.config.ts, and run a cached task graph in a pnpm or Bun workspace.
---

This page takes you from an empty workspace to a cached, parallel task
graph. It assumes **Bun ≥ 1.3** and a workspace under **git** — vx uses
git's index to enumerate and hash inputs, so a git repository is
required.

## 1. Install

vx ships as TypeScript that Bun runs directly — there is no build step.

```bash
bun add -d @vzn/vx
```

This exposes the `vx` binary inside the workspace. vx prepends each
project's `node_modules/.bin` to `PATH` per task, so tools like `tsc`,
`vite`, or `oxlint` resolve from a bare command string.

## 2. Describe a project

Drop a `vx.config.ts` next to any package's `package.json`. Each task is
a single shell command plus an optional cache contract.

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      // The child env is isolated. A cache-input env var must ALSO be
      // passed through, or the key would vary on a value the task
      // can't see.
      exec: { command: 'tsc -p .', env: { passThrough: ['NODE_ENV'] } },
      cache: {
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'bun test' },
      cache: {
        inputs: { files: ['src/**', 'tests/**'] },
        outputs: { files: [] },
      },
    },
  },
})
```

Two rules worth internalizing early:

- **Caching is opt-in and explicit.** When `cache` is present,
  `cache.inputs.files` is required — there are no hidden globs.
- **One command per task.** `exec` is a single command. Chain in the
  shell with `&&`, or split into multiple tasks wired with `dependsOn`.

See the [config schema](/schema/) for every field.

## 3. Run tasks

```bash
vx run build                # current package + its dependency graph
vx run build test --all     # every package, one shared graph
vx run build -F "@app/*"    # pnpm-style filter DSL
vx run test --affected      # only what changed vs the base branch
```

The first run executes and caches. Re-run the same command and vx
replays stored outputs — restore costs about the same as an intact
tree. To see what *would* happen without executing:

```bash
vx run build --dry          # predicted hits/misses
vx run build --graph        # the task graph as text / DOT
```

## 4. Wire dependencies across packages

`dependsOn` uses a small micro-syntax shared with Turbo and Nx:

| Entry        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `'build'`    | the `build` task **in the same project**             |
| `'^build'`   | `build` in each of this project's workspace deps     |
| `'api#build'`| the `build` task in the `api` project specifically   |

vx derives the cross-package edges from your manifests, then folds each
upstream's input hash into the dependent's cache key — so an upstream
change cascades a rebuild through everything that depends on it. The
[execution lifecycle](/execution/) traces exactly what happens during a
run.

## 5. Cache across machines (optional)

Remote caching is two environment variables and speaks a standard
artifact wire, so existing cache servers work unchanged:

```bash
export VX_REMOTE_CACHE_URL=https://cache.example.com
export VX_REMOTE_CACHE_TOKEN=…
# optional: hard-reject unsigned artifacts
export VX_REMOTE_CACHE_SIGNATURE_KEY=…
```

Remote lookups fire concurrently in the background before scheduling, so
network latency overlaps execution, and the remote layer is fully
optional — any error degrades to a local cache miss and the run
continues. Details in [caching](/caching/).

## Where to go next

- **[Why vx](/differentiators/)** — the pitch, with the numbers.
- **[Architecture](/architecture/)** — the shape of the system.
- **[Caching](/caching/)** — keys, invalidation, and early cutoff.
- **[CLI reference](/cli/)** — every flag and exit code.
