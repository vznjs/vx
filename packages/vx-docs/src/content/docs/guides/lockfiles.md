---
title: Lockfile-aware caching
description: Declare pnpm(), bun(), npm() or yarn() from @vzn/vx-lockfile, and a lockfile change re-keys only the projects whose dependencies it reaches.
---

Make an install re-run only the packages it changed. Why keys cascade →
[Chapter 5: Caching](../../guide/caching/)

Without a plugin, the lockfile is in every task's key, so one install
re-runs everything. With one, each package is keyed on its own dependencies.

## Steps

1. Install: `bun add -d @vzn/vx-lockfile`.
2. Declare the plugin for your package manager: `pnpm()`, `bun()`, `npm()` or `yarn()`.
3. Change one dependency and run `vx run build --all --dry`: only the packages that reach it miss.
4. `vx why <task>` names the part as `plugin @vzn/vx-lockfile/pnpm`.
5. `--affected` now selects only those packages, too.

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()], // pnpm({ scope: 'workspace' }) keys the whole file instead
})
```

## What each package's key folds

With `pnpm()`: every package it reaches, by name, version and resolved
peers, with its integrity and any patch. Install-wide, for every package:
`lockfileVersion`, `settings`, `overrides`, `packageExtensionsChecksum`,
`pnpmfileChecksum` and `ignoredOptionalDependencies`.

With `bun()`: the same through Bun's hoisted layout. Install-wide:
`lockfileVersion`, `configVersion`, `overrides`, `patchedDependencies`,
`catalog` and `catalogs`.

With `npm()`: `package-lock.json` versions 2 and 3. With `yarn()`: berry
lockfiles per workspace; a yarn 1 lockfile records no workspaces, so every
package folds the whole file.

## Common problems

- **The run refuses to start and names the lockfile.** The plugin cannot read it. Re-run your install; the message names the command.
- **An import works but is not in the key.** A dependency you import but never declared is in no package's closure. Declare it.
- **A new or deleted lockfile selects everything.** That is on purpose: every `node_modules` is in question.
