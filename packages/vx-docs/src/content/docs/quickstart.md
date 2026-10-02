---
title: Quickstart
description: Install vx, describe one task, and run it from the cache the second time, in a new repo or one you already have.
---

Run your first cached task in five minutes.

You need a git repository on Linux or macOS (on Windows, use WSL). vx is
one prebuilt binary. The release binary alone needs neither Node nor Bun;
installed from npm, the `vx` command is a small Node script that runs
that binary.

## Install

1. Install it at the workspace root: `npm install -D @vzn/vx` (in a pnpm
   workspace, `pnpm add -D -w @vzn/vx`: npm refuses `workspace:*`).
2. Run `npx vx init`. It writes a `vx.config.ts` per package from its
   scripts, and a `vx.workspace.ts`. A root script that checks the whole
   repo (`lint: eslint .`) becomes a task in a root `vx.config.ts`; one
   that runs the members (`pnpm -r build`) does not. No task gets a `cache` block, so
   nothing is cached yet: add the one each `build`'s TODO shows. A
   repo with `turbo.json` or `nx.json` starts at
   [Coming from Turbo or Nx](#coming-from-turbo-or-nx) instead.
3. Or write one by hand, beside a package's `package.json`.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

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
vx run test --affected    # what changed, and its dependents
vx run build --all --dry  # the plan; runs nothing
cd packages/app           # without --all, a run takes the package you are in
vx run build              # ⇢ success local — a hit; restores dist/ if deleted
vx run build --graph      # the task graph as Graphviz DOT
```

The first run stores the result. The second finds nothing changed and
`dist/` still as stored, so it restores nothing: the task's frame closes
`up-to-date` (`► success fresh` in the `--output-logs full` row). Delete
`dist/` and the next run restores it from the cache: `restored-local`, the
`⇢ success local` row.

## An existing repo

Start with one package and leave the rest of your tooling as it is.

1. Give one package a `vx.config.ts` with the command its `build` script runs.
2. Run `vx run build` twice in it. The second run is a cache hit.
3. Edit a file the build reads. `vx run build --dry` now predicts a miss.
4. Add configs to more packages. `^build` orders them by your `package.json` dependencies.

## Coming from Turbo or Nx

`bunx @vzn/vx-migrate` writes the native `vx.config.ts` files from
`turbo.json` or the Nx graph; from there everything above applies.
`vx init` in such a repo writes only a `vx.workspace.ts` declaring
`turbo()` or `nx()`: a temporary start, dropped once the configs exist.
`@vzn/vx-migrate` is not on npm yet: its first publish is pending, so
`bunx @vzn/vx-migrate` and the install `vx init` names fail until then.
[Migrate](../guides/migrate/) has the steps.

## Common problems

- **Only one package ran.** `vx run build` runs the package you are in. Add `--all`.
- **The editor cannot resolve `@vzn/vx`.** Add it as a devDependency. vx itself runs a config without it.
- **`vx requires git`.** Run `git init` at the workspace root.
- **A package has no `vx.config.ts`.** It has no tasks, and `^build` reaches through it to the nearest package that has one.
- **`tsc -b` ran, but `dist/` came back empty.** With `rootDir: "src"`, tsc writes `tsconfig.tsbuildinfo` beside `tsconfig.json`, outside `dist/`. vx empties `dist/` before a miss, tsc sees the buildinfo, thinks it is current and writes nothing. Add `tsconfig.tsbuildinfo` to `outputs.files`, or point `tsBuildInfoFile` into `dist/`.
- **A package has nothing to build, but others depend on it.** Give it `build: { dependsOn: [] }`, so their `^build` waits on nothing.

## Known limits

- Running from source needs Bun ≥ 1.4. The binary needs nothing.
- The Linux sandbox needs `bubblewrap`, `socat` and `ripgrep`, and no root
  in a container, or set `exec.sandbox.weakerWhenNested: true` on each
  sandboxed task ([Sandboxing](../guides/sandboxing/#requirements--platform-support)).
- No native Windows build: use WSL.
- On macOS the sandbox's report can miss records under load. Enforcement
  holds.
- A cache hit replays the first and last 8 MiB of a task's output.
- A `kill -9` of vx leaves its persistent tasks running, except a server
  that exits when its stdin closes (esbuild `--watch`).
