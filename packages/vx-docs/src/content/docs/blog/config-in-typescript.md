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
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'vitest run' },
      cache: { inputs: { files: ['src/**', 'test/**'] }, outputs: { files: [] } },
    },
  },
})
```

`defineProject` is an identity function that exists for autocomplete
and validation. The generated files from `vx init` skip even that and
write `satisfies ProjectConfig` with a type-only import, which is the
same checking without a runtime import of core, worth about 17 ms per
run on a small workspace.

## Composition is an import

A shared preset is a file:

```ts
// vx-preset.ts (workspace root)
export const lib = (entry: string) => ({
  build: {
    exec: { command: `tsup ${entry}` },
    cache: { inputs: { files: ['src/**', 'tsup.config.ts'] }, outputs: { files: ['dist/**'] } },
  },
})
```

```ts
// packages/ui/vx.config.ts
import { lib } from '../../vx-preset.ts'
export default { tasks: { ...lib('src/index.ts') } } satisfies ProjectConfig
```

Because the key hashes the [resolved config](../resolved-config-hashing/),
an edit to `vx-preset.ts` re-keys every task that spread it. There is
no list of global dependencies to maintain, because the dependency is
the import, and the runtime already tracks imports.

The same shape covers what `namedInputs` and `targetDefaults` do. A
named input is a constant. A target default is a function that returns
a task and takes the parts that vary. Nx's `extends` is `...spread`.
All of them are features you already know from the language, checked
by the compiler, refactorable by the editor.

## What a config may not do

A program can do too much, and two things are refused rather than
allowed:

- **Reading another project.** Globs are resolved inside the project
  directory. `../shared/**` is an error, and `cache.inputs.workspaceFiles`
  is the one named exception for files at the workspace root.
- **Being impure without saying so.** A config that reads `process`,
  `Date`, `fetch`, `import.meta` or a dynamic `import()` is evaluated
  live every run and never served from the evaluation cache. That is
  the correct behaviour, not a penalty; it just means a config that
  reads `process.env` should be one that has to.

## Freezing it

When "evaluated live" is exactly what a CI pipeline must not do,
[`vx lock`](../lock-and-frozen/) evaluates every config once and writes
the resolved objects to `vx-lock.json`; `vx run --frozen` consumes the
lock with no evaluation at all, and `--check` catches drift a byte hash
cannot see.

## The migration path

`vx init` writes these files from `package.json` scripts.
`bunx @vzn/vx-migrate` writes them from a `turbo.json` or an Nx project
graph, and when it meets a `globalDependencies` list it generates the
preset file and the import for you, because that is what the list was
trying to be. The schema reference is [Configuration
schema](../../schema/).
