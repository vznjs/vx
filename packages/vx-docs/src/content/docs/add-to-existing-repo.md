---
title: Add vx to an existing repo
description: Adopt vx incrementally in a monorepo you already have — one package at a time, alongside your current tooling.
---

You don't need to convert your whole monorepo at once. vx is happy to run
a single task in a single package while the rest of your tooling stays
exactly as it is. This guide shows the incremental path.

Migrating *from* a specific tool? Those guides generate config for you:
[from Turborepo](../migrate/from-turborepo/),
[from Nx](../migrate/from-nx/). No tool at all? `vx init` writes the
workspace file and one config per package from its `package.json`
scripts; the hand-written path below is the same result, one package at
a time.

## 1. Install at the workspace root

```bash
bun add -d @vzn/vx
# …or globally, as the prebuilt standalone binary:
npm install -g @vzn/vx
```

vx discovers your workspace automatically from `pnpm-workspace.yaml`, a
`package.json` `workspaces` field (npm / yarn / Bun), or a bare
single-package `package.json`. A package only becomes a vx *project* when
it has a `vx.config.ts` — packages without one are still visible in the
dependency graph but contribute no tasks. That's what makes incremental
adoption work.

## 2. Add a config to one package

Pick a package with a clear build step and add a `vx.config.ts` next to
its `package.json`. Point the command at the script you already run:

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      // whatever your package.json "build" script already does
      exec: { command: 'tsc -b' },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json', 'package.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

```bash
vx run build            # from inside that package
```

Run it twice and confirm the second run is a cache hit. You've now got
caching for that package with zero changes to anything else.

## 3. Verify caching is correct before you trust it

Stale cache hits are the one failure mode that matters, so check your
input/output declarations on a real change:

```bash
vx run build --dry      # shows predicted hit/miss + the resolved plan
```

Edit a source file → `--dry` should predict a miss. Edit a file *not*
listed in `inputs.files` that the build actually reads → if `--dry` still
predicts a hit, your `inputs` are too narrow. See
[Caching tasks](../guides/caching/) for getting this right (and why vx
folds `package.json` in automatically).

## 4. Expand outward

Add `vx.config.ts` to more packages and wire cross-package ordering with
the `^` prefix:

```ts
build: {
  dependsOn: ['^build'],     // build workspace deps first
  exec: { command: 'tsc -b' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
}
```

vx derives the cross-package edges from your `package.json`
`dependencies` — you don't redeclare the graph. A package that doesn't
declare `build` is transparently bridged to the nearest dependency that
does, so sparse task coverage is fine.

## 5. Optional: workspace-wide settings

Add a `vx.workspace.ts` at the root only if you need to override
defaults:

```ts
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  concurrency: 8,            // default: navigator.hardwareConcurrency
  cacheDir: '.vx/cache',     // default: .vx/cache (relative to root)
})
```

## 6. Run the whole workspace

```bash
vx run build --all          # every package that declares build
vx run test --affected      # only packages changed vs the base branch
```

## Running alongside your existing runner

vx doesn't touch your `package.json` scripts and writes only to its cache
dir (`.vx/` by default — add it to `.gitignore`). You can keep Turborepo
or Nx running the rest of the repo while you evaluate vx on a few
packages, then switch over when you're confident.

## Next steps

- **[Configuring tasks](../guides/tasks/)** — the full config reference
  in guide form.
- **[Caching tasks](../guides/caching/)** — declare inputs/outputs
  correctly.
- **[Continuous integration](../guides/ci/)** — share the cache across
  CI and developers.
