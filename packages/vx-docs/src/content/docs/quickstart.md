---
title: Quickstart
description: Install vx, describe one task, and run it from the cache the second time.
---

Run your first cached task in five minutes. Why a task runner at all? →
[Chapter 1: Why orchestrate?](../guide/why/)

You need a git repository on Linux or macOS (on Windows, use WSL). vx is
one binary: no Node or Bun to install.

## Steps

1. Install it in the repo: `npm install -D @vzn/vx`.
2. Run `vx init`. It writes a `vx.config.ts` per package from its scripts.
3. Or write one by hand, beside a package's `package.json` (below).
4. Run `vx run build`. It runs the command and stores the result.
5. Run it again. Nothing changed, so vx restores the result.
6. Run `vx run build --all` to build every package, in dependency order.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'], // my dependencies' build first
      exec: { command: 'tsc -b' },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'], // my own build first
      exec: { command: 'bun test' },
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
  },
})
```

## Run

```bash
vx run build --all        # every package, in dependency order
vx run build              # ⇢ success local — a cache hit
vx run test --affected    # what changed, and its dependents
vx run build --all --dry  # the plan; runs nothing
vx run build --graph      # the task graph as Graphviz DOT
```

## Common problems

- **Only one package ran.** `vx run build` runs the package you are in. Add `--all`.
- **A config cannot import `@vzn/vx`.** Add it as a devDependency, even with the release binary.
- **`vx requires git`.** Run `git init` at the workspace root.

## Known limits

- Running from source needs Bun ≥ 1.4. The binary needs nothing.
- The Linux sandbox needs `bubblewrap`, `socat` and `ripgrep`, and no root
  in a container, or set `sandbox.weakerWhenNested: true`
  ([Sandboxing](../guides/sandboxing/#requirements--platform-support)).
- No native Windows build: use WSL.
- On macOS the sandbox's report can miss records under load. Enforcement
  holds.
- A cache hit replays the first and last 8 MiB of a task's output.
- A `workspaceFiles` glob stops at a git submodule's edge.

