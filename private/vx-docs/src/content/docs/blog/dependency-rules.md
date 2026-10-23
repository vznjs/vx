---
title: 'Say which projects may depend on which'
date: 2026-10-14T07:00:00Z
authors:
  - vzn
tags:
  - config
  - nx
excerpt: 'run.rules.dependencies tags the layers of a monorepo and says which may reach which. vx lock refuses a dependency that breaks a rule and names every broken edge. Runs never check it, so they pay nothing. nx() carries most Nx module-boundary constraints over.'
---

`packages/c` is a UI package. It depends on `packages/a`, a utility
the workspace says UI may not reach:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  run: {
    rules: {
      dependencies: [{ from: 'tag:type:ui', deny: ['tag:type:util'] }],
    },
  },
})
```

```sh frame="terminal"
$ vx lock
✗ vx lock  lock not written

  1 dependency breaks run.rules.dependencies
  packages/c depends on packages/a, which run.rules.dependencies[0] (from 'tag:type:ui') denies

  fix  drop the dependency, or change the project's tags or the rule
$ echo $?
1
```

The edge here is a task edge (`c#build` depends on `a#build`), not a
`package.json` dependency. Both count. Demo workspace, vx at
`69617eb`, 2026-10-23.

## Tags and rules

A project names its tags in its own config:

```ts
// packages/button/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tags: ['type:ui'],
  tasks: { build: { exec: { command: 'tsc -b' } } },
})
```

The workspace says what each tag may depend on. A selector is
`tag:<glob>` or a project-name glob:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  run: {
    rules: {
      dependencies: [
        { from: 'tag:type:app', allow: ['tag:type:feature', 'tag:type:ui'] },
        { from: 'tag:type:ui', deny: ['tag:type:feature', 'tag:type:app'] },
      ],
    },
  },
})
```

A dependency must match one of `allow`, when it is given, and none of
`deny`. Every rule that selects a project applies, so a deny wins over
any allow. A project no rule selects is free.

## vx lock holds them

The rules are checked against each project's direct workspace
dependencies: its `package.json` and its cross-project `dependsOn`.
`vx lock` refuses a graph that breaks one, names every broken edge, and
writes nothing, as above.

Allow the edge, or drop it, and the lock is written:

```sh frame="terminal"
$ vx lock
✓ vx lock  6 project configs → .vx/projects.lock.json

$ vx lock --check
✓ vx lock --check  up to date (6 projects)
```

`vx lock --check` in CI fails the same way, so a pull request that adds
a forbidden dependency goes red. Runs never check these rules: under CI
they load configs from the lock, which already passed them
([Lock once, run frozen](../lock-and-frozen/)).

## From Nx

`nx()` from `@vzn/vx-migrate` reads the `depConstraints` of
`@nx/enforce-module-boundaries` in the root ESLint config and fills
`run.rules.dependencies` when the workspace sets none. It reads the file
and never runs it, so ESLint's plugins do not load on a vx run.

```js
// eslint.config.mjs (Nx)
depConstraints: [
  { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:ui'] },
  { sourceTag: 'type:ui', notDependOnLibsWithTags: ['type:feature'] },
]
```

becomes:

```ts
dependencies: [
  { from: 'tag:type:app', allow: ['tag:type:feature', 'tag:type:ui'] },
  { from: 'tag:type:ui', deny: ['tag:type:feature'] },
]
```

One difference: Nx's `@nx/enforce-module-boundaries`
[lint rule](https://github.com/nrwl/nx/blob/master/packages/eslint-plugin/src/rules/enforce-module-boundaries.ts)
checks source imports, while vx checks the dependencies a project
declares. `allSourceTags`, `/regex/` tags and constraints that only ban external
imports are left out; the
[vx-migrate README](https://github.com/vznjs/vx/tree/main/packages/vx-migrate#module-boundaries)
lists them. The schema is in the
[configuration reference](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
