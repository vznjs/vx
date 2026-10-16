---
title: 'Config in TypeScript, and why there are no named inputs'
date: 2026-09-10T23:45:00Z
authors:
  - vzn
tags:
  - config
  - dx
excerpt: "A vx.config.ts is a module: it can import a preset, spread it, compute a command. That one choice removes Turborepo's globalDependencies and Nx's namedInputs from the schema, because a language that composes does not need a schema that does."
---

Turborepo and Nx both grew the same features for the same reason.
`globalDependencies`, `globalEnv`, `namedInputs`, `targetDefaults`,
`extends`: every one of them is a way to say something once and reuse
it, added because JSON cannot say anything once. vx's config is a
TypeScript module, so the feature list is a language feature list, and
it is already complete.

## The shape

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      inputs: { files: ['src/**', 'tsconfig.json'] },
      cache: {
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'vitest run' },
      inputs: { files: ['src/**', 'test/**'] }, cache: { outputs: { files: [] } },
    },
  },
})
```

`defineProject` is an identity function — it returns its argument —
that exists for autocomplete and validation. The files `vx init` and
`@vzn/vx-migrate` generate skip even that and write
`satisfies ProjectConfig` with a type-only import: the same checking
with no runtime import at all.

## Composition is an import

A shared preset is a file:

```ts
// vx-preset.ts (workspace root)
export const lib = (entry: string) => ({
  build: {
    exec: { command: `tsup ${entry}` },
    inputs: { files: ['src/**', 'tsup.config.ts'] }, cache: { outputs: { files: ['dist/**'] } },
  },
})
```

```ts
// packages/ui/vx.config.ts
import type { ProjectConfig } from '@vzn/vx/config'
import { lib } from '../../vx-preset.ts'
export default { tasks: { ...lib('src/index.ts') } } satisfies ProjectConfig
```

Because the key hashes the [resolved config](../resolved-config-hashing/),
an edit to `vx-preset.ts` re-keys every task that spread it once
`vx lock` records it. There is
no list of global dependencies to maintain, because the dependency is
the import, and the runtime already tracks imports.

The same shape covers what `namedInputs` and `targetDefaults` do. A
named input is a constant. A target default is a function that returns
a task and takes the parts that vary. Nx's `extends` is `...spread`.
All of them are features you already know from the language, checked
by the compiler, refactorable by the editor.

## What a config may not do

A program can do too much. Reading another project is refused: globs
are resolved inside the project directory, `../shared/**` is an error,
and `inputs.workspaceFiles` is the one named exception for files
at the workspace root.

A config may read `process.env`, the clock or the network, but it reads
them once, when `vx lock` evaluates it. That answer is frozen into the
lock, and no run evaluates the config again.

## Freezing it

[`vx lock`](../lock-and-frozen/) evaluates every config and writes the
resolved objects to `.vx/projects.lock.json`. Every `vx run` reads the
lock with no evaluation at all, and `vx lock --check` re-evaluates the
configs and reports drift a byte hash cannot see, such as an env value
read at lock time.

## The migration path

`vx init` writes these files from `package.json` scripts.
`bunx @vzn/vx-migrate` writes them from a `turbo.json` or an Nx project
graph, and when it meets a `globalDependencies` list it generates the
preset file and the import for you, because that is what the list was
trying to be. The schema reference is [Configuration
schema](../../schema/).
