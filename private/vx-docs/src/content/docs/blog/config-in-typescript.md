---
title: 'Config in TypeScript, and why there are no named inputs'
date: 2026-09-10T23:45:00Z
authors:
  - vzn
tags:
  - config
  - dx
excerpt: 'A vx.config.ts is TypeScript, so you share settings with an import. That removes globalDependencies and namedInputs from the schema.'
---

A `vx.config.ts` is TypeScript. Share settings with an import, not a
special config key. Here is what `bunx @vzn/vx-migrate` writes from two
`package.json` scripts:

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

Each script became a task with the same command. The tool suggests
inputs and outputs in a comment, and doesn't guess them.

<small>vx-migrate 69617eb · 2026-10-23</small>

`satisfies ProjectConfig` gives autocomplete and type checks with no
runtime import. `defineProject` works too.

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

The key hashes the config [after it runs](../resolved-config-hashing/).
Edit `vx-preset.ts`, run `vx lock`, and every task that uses it gets a
new key.

No list of global dependencies to keep up to date: the import is the
dependency.

| JSON configs need         | In a TypeScript module      |
| ------------------------- | --------------------------- |
| `globalDependencies`      | the import                  |
| `namedInputs`             | a constant                  |
| `targetDefaults`          | a function returning a task |
| `extends`                 | `...spread`                 |

Your compiler checks it, your editor refactors it.

## What a config may not do

A config can't read another project. Globs stay inside the project
folder, and `../shared/**` is an error. `inputs.workspaceFiles` is the
one exception, for files at the workspace root.

A config may read `process.env`, the clock or the network, but only
once, when [`vx lock`](../lock-and-frozen/) runs it. No run runs the
config again.

`bunx @vzn/vx-migrate` also reads `turbo.json` or an Nx graph. A
`globalDependencies` list becomes a preset file and its import. Schema:
[Configuration schema](../../schema/).

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
