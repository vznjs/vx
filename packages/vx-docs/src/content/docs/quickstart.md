---
title: Quickstart
description: Install vx, describe one task, and run it from the cache the second time, in a new repo or one you already have.
---

Run your first cached task in five minutes.

You need a git repository (sha1 or sha256, files or reftable refs, so Git 3's
defaults too) on Linux with glibc (not Alpine's musl) or macOS
(Windows: run vx inside WSL2). vx is
one prebuilt binary. The release binary alone needs neither Node nor Bun;
installed from npm, the `vx` command is a small Node script that runs
that binary.

## Install

1. Install it at the workspace root: `npm install -D @vzn/vx` (in a pnpm
   workspace, `pnpm add -D -w @vzn/vx`: npm refuses `workspace:*`; Bun:
   `bun add -d @vzn/vx`).
2. Run `npx @vzn/vx init` (Bun: `bunx @vzn/vx init`; npm refuses a repo
   whose `devEngines` names Bun). It runs `@vzn/vx-migrate`, which writes a
   `vx.config.ts` per package from its scripts, and a `.vx/workspace.ts`. A root script that checks the whole
   repo (`format: prettier --check .`) becomes a task in a root
   `vx.config.ts`; one that runs the members (`pnpm -r build`) does not,
   nor one named like a package's own task (a root `lint` beside a
   package's `lint`), so `--all` never runs a check twice. No task gets a `cache` block, so
   nothing is cached yet: add the one each `build`'s TODO shows. A
   repo with `turbo.json` or `nx.json` starts at
   [Coming from Turbo, Nx or Vite Task](#coming-from-turbo-nx-or-vite-task) instead.
   With no `package.json` at all (a Go or Rust repo), it writes
   `.vx/workspace.ts` and an empty root `vx.config.ts` to declare tasks in.

`vx init` is how every repo starts. The `.vx/workspace.ts` it writes
marks the workspace root.

## Config

What `vx init` wrote for a package, with the cache block its TODO asks for:

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

Installed from npm, the command is `npx @vzn/vx` (pnpm: `pnpm vx`, Bun:
`bunx @vzn/vx`); the lines below drop the prefix.

```bash
vx lock                   # find each vx.config.ts, resolve it into .vx/projects.lock.json, which runs read
vx run build --all        # every project, in dependency order
vx run test --affected    # changed since main or the last commit, and dependents
vx run build --all --dry  # the plan; runs nothing
cd packages/app           # without --all, a run takes the package you are in
vx run build              # ⇢ success local — after dist/ is deleted; else up-to-date
vx run build --graph      # the task graph as Graphviz DOT
```

A run never evaluates a `vx.config.ts`, and never looks for a new one:
after adding or editing one, run `vx lock` again and commit
`.vx/projects.lock.json`. The first run stores the result. The second finds nothing changed and
`dist/` still as stored, so it restores nothing: the task's frame closes
`up-to-date` (`► success fresh` in the `--output-logs full` row). Delete
`dist/` and the next run restores it from the cache: `restored-local`, the
`⇢ success local` row.

The frame's last line and the end of the summary, from three runs
of a small package (first run, again, again after `rm -rf dist`):

```text
└─ @demo/app#build ── (60ms) success
  cache     1 miss
  time      332ms

└─ @demo/app#build ── (3ms) up-to-date
  time      23ms · 60ms saved

└─ @demo/app#build ── (14ms) restored-local
  time      31ms · 60ms saved
```

## When to run vx lock

`vx init` also writes `.vx/projects.lock.json`: every project's config as it
evaluated. Commit it. Every run reads its configs from the lock and
evaluates none, so after you change one the runs keep the old tasks
until you run `vx lock`. Run it, and commit the lock, after you:

- edit any `vx.config.ts` or `.vx/workspace.ts`,
- update dependencies or plugins,
- change a file a config imports (a shared preset, a helper).

On CI, `vx lock --check` comes first
([the workflow](../guides/ci/#github-actions)): it evaluates every
config again and fails on any difference, naming the project.

## An existing repo

Start with one package and leave the rest of your tooling as it is.

1. Run `npx @vzn/vx init` at the repo root. It writes a `vx.config.ts`
   per package and changes none of your scripts.
2. Add the cache block to one package's `build`, as its TODO shows, and
   run `vx lock`.
3. Run `vx run build` twice in it. The second run is a cache hit. If it
   ran again, `vx why <package>#build` names what changed in its key.
4. Edit a file the build reads. `vx run build --dry` now predicts a miss,
   and after the run `vx why` names that file.

## Coming from Turbo, Nx or Vite Task

`npx @vzn/vx init` beside `turbo.json` or `nx.json` runs `@vzn/vx-migrate`, which
writes the native `vx.config.ts` files from `turbo.json` or the Nx graph
(`bunx @vzn/vx-migrate` does the same from each `vite.config`'s `run.tasks`);
from there everything above applies. `vx init --keep` writes only a
`.vx/workspace.ts` declaring `turbo()` or `nx()` and your lockfile's plugin: a temporary start, dropped
once the configs exist.
[Migrate](../guides/migrate/) has the steps.

## Common problems

- **`--affected has no base here`.** A repo with one commit has nothing to compare with. Commit again, or name a base: `--affected=<ref>`.
- **Only one package ran.** `vx run build` runs the package you are in. Add `--all`.
- **A task ran again with nothing changed.** `vx why <package>#<task>` names what moved in its key: a file, an env var, or an upstream task (often one that rewrites a file this task reads).
- **The editor cannot resolve `@vzn/vx`.** Add it as a devDependency. vx itself runs a config without it.
- **`no .vx/workspace.ts in …`.** The file marks the workspace root. Run `vx init` at the repo root.
- **`vx requires git`.** Run `git init` at the workspace root.
- **A package has no `vx.config.ts`.** It gets a default `build`: a group behind `^build`, keyed on all its files, so editing it re-runs the packages that depend on it.
- **`tsc -b` ran, but `dist/` came back empty.** With `rootDir: "src"`, tsc writes `tsconfig.tsbuildinfo` beside `tsconfig.json`, outside `dist/`. vx empties `dist/` before a miss, tsc sees the buildinfo, thinks it is current and writes nothing. Add `tsconfig.tsbuildinfo` to `outputs.files`, or point `tsBuildInfoFile` into `dist/`.
- **A package has nothing to build, but others depend on it.** Its default `build` waits on its own dependencies' builds. `build: { dependsOn: [] }` waits on nothing, but also drops its files from its dependents' keys: use it only when no dependent reads its source.

## Known limits

- Running from source needs Bun ≥ 1.4. The binary needs nothing.
- The Linux sandbox needs `bubblewrap`, `socat` and `ripgrep`, and no root
  in a container, or set `exec.sandbox.weakerWhenNested: true` on each
  sandboxed task ([Sandboxing](../guides/sandboxing/#requirements--platform-support)).
- Windows: run vx inside WSL2.
- On macOS the sandbox's report can miss records under load. Enforcement
  holds.
- A cache hit replays the first and last 8 MiB of a task's output.
- A `kill -9` of vx leaves its persistent tasks running, except a server
  that exits when its stdin closes (esbuild `--watch`).
- A process a task detaches into its own session (`setsid … &`) outlives
  Ctrl-C: vx signals the task's process group.
