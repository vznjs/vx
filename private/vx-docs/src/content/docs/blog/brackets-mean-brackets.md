---
title: 'Brackets in a glob mean brackets'
date: 2026-10-20T18:20:00Z
authors:
  - vzn
tags:
  - dx
  - config
excerpt: 'In a vx task glob, [jt] is a character class, as in Turbo, Nx and most glob tools. A literal route directory like app/[id] is escaped. One rule, and the cache key follows it.'
---

`[jt]` is a character class. A literal `[id]` is escaped:

```ts
route: {
  exec: { command: 'ls src app/*' },
  inputs: { files: ['src/*.[jt]s', 'app/\\[id\\]/**'] },
  cache: { outputs: { files: [] } },
}
```

```sh frame="terminal"
$ echo "// e" >> app/i/x.ts          # not an input
$ vx run packages/c#route
  cache     local 1✓

$ echo "// e" >> 'app/[id]/page.ts'  # the escaped route
$ vx run packages/c#route
  cache     local 1↑

$ echo "// e" >> src/j.js            # matched by [jt]
$ vx run packages/c#route
  cache     local 1↑
```

Linux x64, vx at `69617eb`, 2026-10-23. (The double backslash is the
TypeScript string's escape.)

## One meaning everywhere

A Next.js app keeps routes in directories like `app/[id]`. In almost
every glob tool, `[id]` means one character, `i` or `d`, so the route
needs `app/\[id\]`. vx reads it the same way:

| Glob               | Matches                        |
| ------------------ | ------------------------------ |
| `src/*.[jt]s`      | `.js` and `.ts` files in `src` |
| `app/[id]/**`      | `app/i/**`, `app/d/**`         |
| `app/\[id\]/**`    | the `app/[id]/` directory      |

A glob copied from `turbo.json`, an Nx project or a shell means the
same thing in a `vx.config.ts`. `@vzn/vx-migrate` passes Turbo's and
Nx's classes through unchanged, and escapes brackets in any path it
writes.

## Why the cache version moved

A glob is part of a task's key. Reading brackets as a class made the
same glob string select different files, and a key that stays the same
over different inputs can replay outputs built from the wrong files.
So 0.0.644 moved the cache version to `vx-cache-v48`, and every cached
task missed once after that upgrade. Pre-1.0, a breaking change ships
with no setting to keep the old reading.

Glob rules: [Caching](../../caching/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
