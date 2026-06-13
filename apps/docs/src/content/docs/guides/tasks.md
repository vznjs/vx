---
title: Configuring tasks
description: Write vx.config.ts — define tasks as shell commands, wire dependencies, and declare cache contracts. The practical guide to the config.
---

A `vx.config.ts` lives next to a package's `package.json` and declares
that package's tasks. This guide covers the shape you'll use day to day.
For the exhaustive field-by-field reference, see
[Configuration](../../schema/).

## The basic shape

```ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
})
```

- `tasks` is a map of task name → task config. Names are arbitrary
  strings, referenced by the CLI (`vx run build`) and by other tasks'
  `dependsOn`.
- `defineProject` is an identity function — it exists only so TypeScript
  gives you autocomplete and validates the object. No runtime cost.

## A task is one shell command

```ts
exec: { command: 'tsc -b' }
```

`command` is a single string run through the shell, from the package's
own directory. Full POSIX semantics work — pipes, redirects, `&&`:

```ts
exec: { command: 'codegen && tsc -b && cp -r assets dist/' }
```

There's deliberately no `commands: string[]`. If you'd benefit from
caching each step independently, split them into separate tasks linked by
`dependsOn`. If you wouldn't, `&&` is the right tool. This "shell is the
API" rule is why vx needs no plugins or executor protocol.

Each task runs with the package's `node_modules/.bin` prepended to
`PATH`, so local tools resolve from a bare command — no `npx`.

## Declaring dependencies

```ts
test: {
  dependsOn: ['build'],
  exec: { command: 'bun test' },
  cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
}
```

`dependsOn` uses the Turborepo/Nx micro-syntax:

| Form         | Meaning                                                     |
| ------------ | ---------------------------------------------------------- |
| `'build'`    | the `build` task **in this same package**                  |
| `'^build'`   | `build` in each of this package's **workspace dependencies** |
| `'api#build'`| the `build` task in the **`api` package** specifically     |

Full semantics — including how `^` bridges packages that don't declare
the task — are in [Task dependencies](../task-dependencies/).

## Declaring the cache contract

Caching is **opt-in**. Add a `cache` block and you must declare both what
the task reads and what it writes:

```ts
cache: {
  inputs: { files: ['src/**', 'tsconfig.json'] },
  outputs: { files: ['dist/**'] },
}
```

- `inputs.files` — project-relative globs of everything the task reads.
  `!` negates (`['src/**', '!**/*.test.ts']`).
- `outputs.files` — globs of what it produces. Use `[]` for tasks like
  `lint`/`test` that produce no files (you still cache the success).

Getting these right is the whole game — [Caching tasks](../caching/)
covers it in depth, including the files vx folds in automatically
(`package.json`, the lockfile) and how to handle env vars and
root-level inputs.

Omit `cache` entirely and the task simply always runs.

## Group tasks (aggregators)

A task with `dependsOn` but no `exec` is a **group** — running it just
runs its dependencies. This is how you build a `ci` umbrella or a
"build everything" entry point:

```ts
ci: {
  description: 'format-check + lint + test',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

Groups don't spawn anything, don't appear in the run count, and can't
have a `cache` block — but a change anywhere beneath them still cascades
correctly to downstream tasks.

## Reusing config with presets

Because the config is TypeScript, you share logic with imports — no
special "named inputs" schema needed. A preset is just a function
returning a task:

```ts
// presets/ts-build.ts
import type { TaskConfig } from '@vzn/vx'

export const tsBuild = (): TaskConfig => ({
  exec: { command: 'tsc -b' },
  cache: { inputs: { files: ['src/**', 'tsconfig.json'] }, outputs: { files: ['dist/**'] } },
})
```

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'
import { tsBuild } from '../../presets/ts-build.ts'

export default defineProject({
  tasks: { build: tsBuild() },
})
```

vx hashes the **resolved** config, so a preset change correctly
invalidates every task that uses it — something static-JSON config in
Turborepo and Nx can't do.

## Describe tasks for humans

`description` is optional metadata shown in the interactive picker and
`--dry` output:

```ts
build: {
  description: 'compile TypeScript to dist/',
  exec: { command: 'tsc -b' },
  // ...
}
```

## Beyond the basics

A task can also declare:

- **`exec.env`** — control the child's environment
  ([Environment variables](../environment-variables/)).
- **`exec.persistent`** — long-running dev servers and watchers
  ([Dev & long-running tasks](../dev-tasks/)).
- **`sandbox`** — run under an OS-level allow-list of files and network
  ([Sandboxing tasks](../sandboxing/)).

Workspace-wide settings (`concurrency`, `cacheDir`) live in a root
`vx.workspace.ts` — see [Workspace configuration](../workspace-config/).

## Next steps

- **[Caching tasks](../caching/)** — inputs, outputs, env, and
  correctness.
- **[Task dependencies](../task-dependencies/)** — `^`, `pkg#task`, and
  cross-package graphs.
- **[Configuration reference](../../schema/)** — every field, including
  the full `sandbox` surface.
