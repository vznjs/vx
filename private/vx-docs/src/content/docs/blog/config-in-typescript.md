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

Two `package.json` scripts, and what `bunx @vzn/vx-migrate` writes
from them:

```sh frame="terminal"
$ cat packages/ui/package.json
{"name":"ui","scripts":{"build":"tsc -b","test":"vitest run"}}

$ bunx @vzn/vx-migrate
  from      package.json scripts
  tasks     1 clean · 1 todo
  files     packages/ui/vx.config.ts
…
$ cat packages/ui/vx.config.ts
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    // TODO(vx-migrate): cache: add `inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } }` with this package's real inputs and outputs — …
    build: {
      // inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      exec: {
        command: 'tsc -b',
      },
      dependsOn: ['^build'],
    },
    test: {
      exec: {
        command: 'vitest run',
      },
      dependsOn: ['build'],
    },
  },
} satisfies ProjectConfig
```

Each script became a task with its command verbatim. Caching needs
inputs and outputs you declare, so the tool proposes them in a comment
and doesn't guess. vx-migrate at `69617eb`, 2026-10-23.

The file is a TypeScript module. `satisfies ProjectConfig` with a
type-only import gives autocomplete and checking with no runtime import.
`defineProject` does the same as an identity function, if you prefer
it.

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

| JSON configs need         | In a TypeScript module      |
| ------------------------- | --------------------------- |
| `globalDependencies`      | the import                  |
| `namedInputs`             | a constant                  |
| `targetDefaults`          | a function returning a task |
| `extends`                 | `...spread`                 |

Checked by the compiler, refactored by the editor.

## What a config may not do

A program can do too much. Reading another project is refused: globs
are resolved inside the project directory, `../shared/**` is an error,
and `inputs.workspaceFiles` is the one named exception for files
at the workspace root.

A config may read `process.env`, the clock or the network, but it reads
them once, when `vx lock` evaluates it. That answer is frozen into the
lock, and no run evaluates the config again.

[`vx lock`](../lock-and-frozen/) freezes the evaluated configs; every
run reads the lock and evaluates nothing.

`bunx @vzn/vx-migrate` also reads a `turbo.json` or an Nx project
graph. A `globalDependencies` list becomes a preset file and its import,
because that is what the list was trying to be. Schema:
[Configuration schema](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
